/**
 * Project management and target scoping.
 * Scans projects in the shared root directory and enforces strict boundary security
 * so no CLI or git operation can bleed context or traverse outside its project folder.
 */

import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

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
