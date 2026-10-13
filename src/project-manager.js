/**
 * Project management and target scoping.
 * Scans projects in the shared root directory and enforces strict boundary security
 * so no CLI or git operation can bleed context or traverse outside its project folder.
 */

import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export class ProjectManager {
  constructor(rootDir) {
    if (!rootDir) {
      throw new Error('ProjectManager requires a valid rootDir');
    }
    this.rootDir = path.resolve(rootDir);
  }

  getRootDir() {
    return this.rootDir;
  }

  /**
   * Validates a candidate project name before creation.
   * Ensures the name is safe, does not traverse boundaries, and does not already exist.
   */
  validateNewProjectName(projectName) {
    if (!projectName || typeof projectName !== 'string') {
      const err = new Error('Project name must be a non-empty string');
      err.status = 400;
      throw err;
    }

    const cleanName = projectName.trim();
    if (!cleanName) {
      const err = new Error('Project name cannot be empty');
      err.status = 400;
      throw err;
    }

    // Must be a valid folder name: allow alphanumeric, hyphens, underscores, dots
    // Block any path separator, null byte, leading dashes, or traversal attempts
    if (
      cleanName.includes('/') ||
      cleanName.includes('\\') ||
      cleanName.includes('\0') ||
      cleanName === '..' ||
      cleanName === '.' ||
      cleanName.startsWith('-') ||
      !/^[a-zA-Z0-9_.-]+$/.test(cleanName)
    ) {
      const err = new Error(`Invalid project name or traversal attempt: "${cleanName}". Use only alphanumeric characters, hyphens, underscores, and dots.`);
      err.status = 400;
      throw err;
    }

    const resolved = path.resolve(this.rootDir, cleanName);
    const expectedPrefix = this.rootDir.endsWith(path.sep) ? this.rootDir : this.rootDir + path.sep;
    if (!resolved.startsWith(expectedPrefix)) {
      const err = new Error(`Security Violation: Target path is outside root directory: ${resolved}`);
      err.status = 403;
      throw err;
    }

    if (existsSync(resolved)) {
      const err = new Error(`A project or folder named "${cleanName}" already exists`);
      err.status = 409;
      throw err;
    }

    return { cleanName, resolvedPath: resolved };
  }

  /**
   * Creates a new project workspace directory, with optional git init or cloning.
   */
  async createProject(options = {}) {
    const {
      name,
      initGit = true,
      cloneUrl = null,
      description = '',
      initialCommit = true,
      defaultBranch = 'main'
    } = options;

    const { cleanName, resolvedPath } = this.validateNewProjectName(name);

    if (cloneUrl) {
      const trimmedUrl = typeof cloneUrl === 'string' ? cloneUrl.trim() : '';
      if (!trimmedUrl) {
        const err = new Error('Git clone URL cannot be empty');
        err.status = 400;
        throw err;
      }
      if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(trimmedUrl)) {
        const err = new Error('Invalid clone URL scheme. Must be HTTPS, SSH, or valid Git URL');
        err.status = 400;
        throw err;
      }

      try {
        await execFileAsync('git', ['clone', trimmedUrl, resolvedPath], {
          timeout: 120000
        });
      } catch (err) {
        try {
          if (existsSync(resolvedPath)) {
            await fs.rm(resolvedPath, { recursive: true, force: true });
          }
        } catch {}
        const gitErr = new Error(`Failed to clone repository: ${err.stderr || err.message}`);
        gitErr.status = 500;
        throw gitErr;
      }
    } else {
      await fs.mkdir(resolvedPath, { recursive: true });

      if (initGit) {
        try {
          try {
            await execFileAsync('git', ['init', '-b', defaultBranch], { cwd: resolvedPath });
          } catch {
            await execFileAsync('git', ['init'], { cwd: resolvedPath });
            try {
              await execFileAsync('git', ['checkout', '-b', defaultBranch], { cwd: resolvedPath });
            } catch {}
          }

          const gitignoreContent = [
            'node_modules/',
            'dist/',
            'build/',
            '.env',
            '.env.local',
            '*.log',
            '.DS_Store'
          ].join('\n') + '\n';
          await fs.writeFile(path.join(resolvedPath, '.gitignore'), gitignoreContent, 'utf8');

          const readmeHeading = `# ${cleanName}\n\n`;
          const readmeBody = description.trim()
            ? `${description.trim()}\n`
            : `Project initialized via Cursor Agent Mobile Control Panel.\n`;
          await fs.writeFile(path.join(resolvedPath, 'README.md'), readmeHeading + readmeBody, 'utf8');

          if (initialCommit) {
            await execFileAsync('git', ['add', '.'], { cwd: resolvedPath });
            await execFileAsync('git', ['commit', '-m', 'Initial commit'], {
              cwd: resolvedPath,
              env: {
                ...process.env,
                GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'Cursor Agent',
                GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'agent@cursor.local',
                GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'Cursor Agent',
                GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'agent@cursor.local'
              }
            });
          }
        } catch (err) {
          console.warn(`Git init warning for ${cleanName}:`, err.message);
        }
      }
    }

    return this.getProject(cleanName);
  }

  /**
   * Strictly scopes and validates a project name to prevent directory traversal
   * and ensure operations execute ONLY inside rootDir/<projectName>.
   */
  resolveSafeProjectPath(projectName) {
    if (!projectName || typeof projectName !== 'string') {
      throw new Error('Project name must be a non-empty string');
    }

    // Clean input
    const cleanName = projectName.trim();
    if (!cleanName) {
      throw new Error('Project name cannot be empty');
    }

    // Block any path separator or null byte or directory traversal attempts
    if (
      cleanName.includes('/') ||
      cleanName.includes('\\') ||
      cleanName.includes('\0') ||
      cleanName === '..' ||
      cleanName === '.'
    ) {
      throw new Error(`Invalid project name or traversal attempt: "${cleanName}"`);
    }

    const resolved = path.resolve(this.rootDir, cleanName);

    // Enforce that resolved is strictly a child directory of rootDir
    const expectedPrefix = this.rootDir.endsWith(path.sep) ? this.rootDir : this.rootDir + path.sep;
    if (!resolved.startsWith(expectedPrefix)) {
      throw new Error(`Security Violation: Target path is outside root directory: ${resolved}`);
    }

    if (!existsSync(resolved)) {
      throw new Error(`Project directory does not exist: ${cleanName}`);
    }

    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Project path is not a directory: ${cleanName}`);
    }

    return resolved;
  }

  /**
   * List all project subdirectories in the root directory with Git & status metadata
   */
  async listProjects() {
    let entries = [];
    try {
      entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch (err) {
      console.error(`Failed to read root directory ${this.rootDir}:`, err.message);
      return [];
    }

    const projectList = [];

    for (const entry of entries) {
      // Exclude hidden folders, system folders, or non-directories
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;

      const projectPath = path.join(this.rootDir, entry.name);
      const isGit = existsSync(path.join(projectPath, '.git'));
      let branch = null;
      let dirtyCount = 0;
      let lastCommitMessage = '';
      let mtime = 0;

      try {
        const stat = await fs.stat(projectPath);
        mtime = stat.mtimeMs;
      } catch {
        // ignore stat errors
      }

      if (isGit) {
        // Fast git status inspection
        try {
          const { stdout: branchOut } = await execAsync('git branch --show-current', {
            cwd: projectPath,
            timeout: 1000
          });
          branch = branchOut.trim() || 'detached';
        } catch {
          // If detached or error, try reading .git/HEAD
          try {
            const head = await fs.readFile(path.join(projectPath, '.git', 'HEAD'), 'utf8');
            branch = head.replace(/^ref: refs\/heads\//, '').trim() || 'unknown';
          } catch {
            branch = 'unknown';
          }
        }

        try {
          const { stdout: statusOut } = await execAsync('git status --porcelain', {
            cwd: projectPath,
            timeout: 1500
          });
          const lines = statusOut.trim().split('\n').filter(Boolean);
          dirtyCount = lines.length;
        } catch {
          dirtyCount = 0;
        }

        try {
          const { stdout: logOut } = await execAsync('git log -1 --format="%s"', {
            cwd: projectPath,
            timeout: 1000
          });
          lastCommitMessage = logOut.trim();
        } catch {
          lastCommitMessage = '';
        }
      }

      projectList.push({
        name: entry.name,
        path: projectPath,
        isGit,
        branch,
        dirtyCount,
        lastCommitMessage,
        mtime
      });
    }

    // Sort alphabetically by default
    projectList.sort((a, b) => a.name.localeCompare(b.name));
    return projectList;
  }

  /**
   * Get metadata for a specific project
   */
  async getProject(projectName) {
    const projectPath = this.resolveSafeProjectPath(projectName);
    const isGit = existsSync(path.join(projectPath, '.git'));
    let branch = null;
    let dirtyCount = 0;
    let lastCommit = null;

    if (isGit) {
      try {
        const { stdout: branchOut } = await execAsync('git branch --show-current', {
          cwd: projectPath,
          timeout: 1000
        });
        branch = branchOut.trim() || 'HEAD';
      } catch {
        branch = 'unknown';
      }

      try {
        const { stdout: statusOut } = await execAsync('git status --porcelain', {
          cwd: projectPath,
          timeout: 1500
        });
        dirtyCount = statusOut.trim().split('\n').filter(Boolean).length;
      } catch {
        dirtyCount = 0;
      }

      try {
        const { stdout: logOut } = await execAsync('git log -1 --format="%h|%s|%cr"', {
          cwd: projectPath,
          timeout: 1000
        });
        const [hash, msg, relativeTime] = logOut.trim().split('|');
        if (hash) {
          lastCommit = { hash, msg, relativeTime };
        }
      } catch {
        lastCommit = null;
      }
    }

    return {
      name: projectName,
      path: projectPath,
      isGit,
      branch,
      dirtyCount,
      lastCommit
    };
  }
}
