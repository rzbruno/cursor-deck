/**
 * Strictly scoped local Git manager.
 * Provides in-browser inspection tabs for git status, git diff,
 * emergency discard (reset --hard & clean -fd), and local commits.
 * Operates purely on the local filesystem with zero remote/GitHub dependency.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GitManager {
  constructor(options = {}) {
    this.projectManager = options.projectManager;
    this.sseHub = options.sseHub;
  }

  /**
   * Helper to execute git command strictly inside the project's directory
   */
  async execGit(projectName, args, options = {}) {
    const projectPath = this.projectManager.resolveSafeProjectPath(projectName);
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: projectPath,
        maxBuffer: 10 * 1024 * 1024, // 10MB diff buffer
        timeout: 10000,
        ...options
      });
      return { stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (err) {
      // Enhance error with git command details
      const gitErr = new Error(`Git error in ${projectName} (git ${args.join(' ')}): ${err.stderr || err.message}`);
      gitErr.code = err.code;
      gitErr.stdout = err.stdout;
      gitErr.stderr = err.stderr;
      throw gitErr;
    }
  }

  /**
   * Check if project is a Git repository
   */
  async isGitRepo(projectName) {
    try {
      await this.execGit(projectName, ['rev-parse', '--is-inside-work-tree']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get detailed git status: branch, files, stats
   */
  async getStatus(projectName) {
    const isGit = await this.isGitRepo(projectName);
    if (!isGit) {
      return {
        isGit: false,
        message: 'Not a git repository'
      };
    }

    // Run git status --porcelain=v1 -b
    const { stdout: porcelain } = await this.execGit(projectName, ['status', '--porcelain=v1', '-b']);
    const lines = porcelain.split('\n').filter(Boolean);

    let branch = 'unknown';
    let upstream = null;
    let ahead = 0;
    let behind = 0;
    const files = [];

    for (const line of lines) {
      if (line.startsWith('## ')) {
        // Branch header, e.g. "## main...origin/main [ahead 1]"
        const branchHeader = line.substring(3).trim();
        const parts = branchHeader.split('...');
        branch = parts[0];
        if (parts[1]) {
          const match = parts[1].match(/^([^\s]+)(\s+\[ahead\s+(\d+)\])?(\s+\[behind\s+(\d+)\])?/);
          if (match) {
            upstream = match[1];
            if (match[3]) ahead = parseInt(match[3], 10);
            if (match[5]) behind = parseInt(match[5], 10);
          }
        }
        continue;
      }

      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const filePath = line.substring(3).trim();

      let category = 'modified';
      if (indexStatus === '?' && workTreeStatus === '?') {
        category = 'untracked';
      } else if (indexStatus === 'A' || workTreeStatus === 'A') {
        category = 'added';
      } else if (indexStatus === 'D' || workTreeStatus === 'D') {
        category = 'deleted';
      } else if (indexStatus === 'R' || workTreeStatus === 'R') {
        category = 'renamed';
      } else if (indexStatus !== ' ' && workTreeStatus === ' ') {
        category = 'staged';
      }

      files.push({
        path: filePath,
        indexStatus,
        workTreeStatus,
        category,
        isStaged: indexStatus !== ' ' && indexStatus !== '?'
      });
    }

    // Get recent commits
    let recentCommits = [];
    try {
      const { stdout: logOut } = await this.execGit(projectName, [
        'log',
        '-5',
        '--format=%h|%an|%cr|%s'
      ]);
      recentCommits = logOut.split('\n').filter(Boolean).map(l => {
        const [hash, author, date, subject] = l.split('|');
        return { hash, author, date, subject };
      });
    } catch {
      // Repo might have zero commits yet
    }

    return {
      isGit: true,
      branch,
      upstream,
      ahead,
      behind,
      files,
      stats: {
        total: files.length,
        staged: files.filter(f => f.isStaged).length,
        unstaged: files.filter(f => !f.isStaged && f.category !== 'untracked').length,
        untracked: files.filter(f => f.category === 'untracked').length
      },
      recentCommits
    };
  }

  /**
   * Get parsed Git diff
   */
  async getDiff(projectName, options = {}) {
    const isGit = await this.isGitRepo(projectName);
    if (!isGit) {
      return { isGit: false, diff: '', files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } };
    }

    const { target = 'all', filePath } = options;
    const gitArgs = ['diff'];

    // Check if HEAD exists
    let hasHead = true;
    try {
      await this.execGit(projectName, ['rev-parse', '--verify', 'HEAD']);
    } catch {
      hasHead = false;
    }

    if (target === 'staged') {
      gitArgs.push('--cached');
    } else if (target === 'all' && hasHead) {
      // Compare working tree + staged against HEAD
      gitArgs.push('HEAD');
    }

    gitArgs.push('--color=never');
    if (filePath) {
      gitArgs.push('--', filePath);
    }

    let rawDiff = '';
    try {
      const { stdout } = await this.execGit(projectName, gitArgs);
      rawDiff = stdout;
    } catch (err) {
      rawDiff = err.stdout || '';
    }

    // Parse diff into structured files and hunks
    const parsedFiles = this.parseUnifiedDiff(rawDiff);

    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const f of parsedFiles) {
      totalAdditions += f.additions;
      totalDeletions += f.deletions;
    }

    return {
      isGit: true,
      raw: rawDiff,
      files: parsedFiles,
      stats: {
        filesChanged: parsedFiles.length,
        additions: totalAdditions,
        deletions: totalDeletions
      }
    };
  }

  /**
   * Parse unified diff into structured data for mobile syntax rendering
   */
  parseUnifiedDiff(diffText) {
    if (!diffText) return [];

    const fileBlocks = [];
    const lines = diffText.split('\n');
    let currentFile = null;
    let currentHunk = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('diff --git ')) {
        if (currentFile) fileBlocks.push(currentFile);
        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        currentFile = {
          fileA: match ? match[1] : '',
          fileB: match ? match[2] : '',
          fileName: match ? match[2] : 'unknown',
          additions: 0,
          deletions: 0,
          hunks: []
        };
        currentHunk = null;
        continue;
      }

      if (!currentFile) continue;

      if (line.startsWith('@@ ')) {
        const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
        currentHunk = {
          header: line,
          oldStart: hunkMatch ? parseInt(hunkMatch[1], 10) : 0,
          newStart: hunkMatch ? parseInt(hunkMatch[3], 10) : 0,
          lines: []
        };
        currentFile.hunks.push(currentHunk);
        continue;
      }

      if (currentHunk) {
        if (line.startsWith('+')) {
          currentFile.additions++;
          currentHunk.lines.push({ type: 'add', content: line.substring(1) });
        } else if (line.startsWith('-')) {
          currentFile.deletions++;
          currentHunk.lines.push({ type: 'del', content: line.substring(1) });
        } else if (line.startsWith(' ')) {
          currentHunk.lines.push({ type: 'ctx', content: line.substring(1) });
        } else if (line.startsWith('\\ No newline at end of file')) {
          currentHunk.lines.push({ type: 'meta', content: line });
        }
      }
    }

    if (currentFile) fileBlocks.push(currentFile);
    return fileBlocks;
  }

  /**
   * Emergency Discard: hard resets HEAD and forcefully cleans all untracked files
   */
  async emergencyDiscard(projectName) {
    const isGit = await this.isGitRepo(projectName);
    if (!isGit) {
      throw new Error(`Project ${projectName} is not a git repository`);
    }

    // 1. Reset all tracked changes
    await this.execGit(projectName, ['reset', '--hard', 'HEAD']);

    // 2. Clean all untracked files and directories
    await this.execGit(projectName, ['clean', '-fd']);

    // Announce to SSE stream
    this.sseHub?.publishLog(
      projectName,
      `\x1b[1;31m🚨 Emergency Discard executed: git reset --hard HEAD && git clean -fd\x1b[0m\n` +
      `\x1b[90mWorking directory restored to clean HEAD state.\x1b[0m\n`,
      'system'
    );

    // Return refreshed status
    return this.getStatus(projectName);
  }

  /**
   * Local Git commit strictly on laptop filesystem
   */
  async commitChanges(projectName, message, stageAll = true) {
    if (!message || !message.trim()) {
      throw new Error('Commit message cannot be empty');
    }

    if (stageAll) {
      await this.execGit(projectName, ['add', '-A']);
    }

    const { stdout } = await this.execGit(projectName, ['commit', '-m', message.trim()]);

    this.sseHub?.publishLog(
      projectName,
      `\x1b[1;32m✔ Git commit created:\x1b[0m ${message.trim()}\n`,
      'system'
    );

    return { success: true, output: stdout, status: await this.getStatus(projectName) };
  }

  /**
   * Stage specific files or all files
   */
  async stageFiles(projectName, files = []) {
    if (!files || files.length === 0) {
      await this.execGit(projectName, ['add', '-A']);
    } else {
      await this.execGit(projectName, ['add', '--', ...files]);
    }
    return this.getStatus(projectName);
  }

  /**
   * Unstage specific files or all files
   */
  async unstageFiles(projectName, files = []) {
    if (!files || files.length === 0) {
      await this.execGit(projectName, ['reset', 'HEAD']);
    } else {
      await this.execGit(projectName, ['reset', 'HEAD', '--', ...files]);
    }
    return this.getStatus(projectName);
  }
}
