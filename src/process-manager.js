/**
 * Headless Process Manager for Cursor CLI (`agent -p --force --trust`).
 * Enforces detached stdin to eliminate prompt lockups, handles strict single-task locking,
 * provides immediate abort controls, and manages multi-turn session continuation.
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';

export class ProcessManager {
  constructor(options = {}) {
    this.sseHub = options.sseHub;
    this.projectManager = options.projectManager;
    this.agentCmd = options.agentCmd || process.env.CURSOR_AGENT_CMD || 'agent';

    // Global single-task lock
    this.activeTask = null;

    // Track multi-turn sessions per project
    // project -> { turnCount: number, lastPrompt: string, lastStatus: string, lastRunAt: number }
    this.projectSessions = new Map();
  }

  /**
   * Check if an agent execution is currently running
   */
  isBusy() {
    return Boolean(this.activeTask && !this.activeTask.isFinished);
  }

  /**
   * Get information about the currently running task (if any)
   */
  getActiveTaskInfo() {
    if (!this.activeTask || this.activeTask.isFinished) return null;
    return {
      projectName: this.activeTask.projectName,
      prompt: this.activeTask.prompt,
      continueSession: this.activeTask.continueSession,
      mode: this.activeTask.mode || 'agent',
      startTime: this.activeTask.startTime,
      elapsedMs: Date.now() - this.activeTask.startTime,
      pid: this.activeTask.pid
    };
  }

  /**
   * Get session stats for a project
   */
  getSession(projectName) {
    const session = this.projectSessions.get(projectName) || {
      turnCount: 0,
      lastPrompt: null,
      lastStatus: 'idle',
      lastRunAt: null
    };
    return {
      ...session,
      isBusy: this.activeTask?.projectName === projectName && !this.activeTask?.isFinished
    };
  }

  /**
   * Reset session continuation for a project
   */
  resetSession(projectName) {
    this.projectSessions.delete(projectName);
    this.sseHub?.publishLog(
      projectName,
      `[SYSTEM] Session history reset for project "${projectName}". Next run will be a fresh start.`,
      'system'
    );
    return { success: true };
  }

  /**
   * Execute Cursor agent headlessly scoped to project
   */
  async runTask({ projectName, prompt, continueSession = false, mode, model }) {
    if (this.isBusy()) {
      const err = new Error(
        `Process locked: Another task is currently running in "${this.activeTask.projectName}".`
      );
      err.status = 409;
      err.activeTask = this.getActiveTaskInfo();
      throw err;
    }

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      const err = new Error('Prompt cannot be empty');
      err.status = 400;
      throw err;
    }

    // Resolve safe path with strict scoping
    const projectPath = this.projectManager.resolveSafeProjectPath(projectName);

    const effectiveMode = (mode && ['plan', 'ask'].includes(String(mode).toLowerCase()))
      ? String(mode).toLowerCase()
      : 'agent';

    // Build arguments strictly according to requirements:
    // agent -p --force --trust with detached stdin and optional --continue
    const args = ['-p', '--force', '--trust'];

    if (continueSession) {
      args.push('--continue');
    }

    if (effectiveMode === 'plan') {
      args.push('--mode', 'plan');
    } else if (effectiveMode === 'ask') {
      args.push('--mode', 'ask');
    }

    if (model) {
      args.push('--model', model);
    }

    // Initial prompt as argument
    args.push(prompt.trim());

    // Update session turn count
    const session = this.projectSessions.get(projectName) || { turnCount: 0 };
    session.turnCount = continueSession ? session.turnCount + 1 : 1;
    session.lastPrompt = prompt.trim();
    session.lastRunAt = Date.now();
    this.projectSessions.set(projectName, session);

    // Prepare task record
    const startTime = Date.now();
    const taskRecord = {
      projectName,
      projectPath,
      prompt: prompt.trim(),
      continueSession: Boolean(continueSession),
      mode: effectiveMode,
      startTime,
      pid: null,
      childProcess: null,
      isFinished: false,
      aborted: false
    };

    this.activeTask = taskRecord;

    // Announce start in SSE stream
    const modeBadge = ` [${effectiveMode.toUpperCase()}]`;
    const contBadge = continueSession ? ' [CONTINUE]' : ' [NEW SESSION]';
    this.sseHub.publishLog(
      projectName,
      `\x1b[1;36m▶ Spawning Cursor CLI in ~/code/${projectName}${modeBadge}${contBadge}\x1b[0m\n` +
      `\x1b[90m$ ${this.agentCmd} ${args.slice(0, -1).join(' ')} "${prompt.trim().substring(0, 80)}${prompt.length > 80 ? '...' : ''}"\x1b[0m\n`,
      'system'
    );

    this.sseHub.publishStatus(projectName, {
      status: 'running',
      prompt: prompt.trim(),
      mode: effectiveMode,
      continueSession: Boolean(continueSession),
      startTime,
      turnCount: session.turnCount
    });

    let child;
    try {
      // Spawn with detached stdin ['ignore', 'pipe', 'pipe']
      // to eliminate terminal prompt lockups completely
      child = spawn(this.agentCmd, args, {
        cwd: projectPath, // STRICT TARGET SCOPING!
        stdio: ['ignore', 'pipe', 'pipe'], // Detached stdin!
        env: {
          ...process.env,
          CI: '1',
          FORCE_COLOR: '1',
          TERM: 'xterm-256color'
        },
        detached: true // Allows killing the entire process group
      });
    } catch (err) {
      this.activeTask = null;
      this.sseHub.publishLog(projectName, `\x1b[1;31m✖ Failed to spawn ${this.agentCmd}: ${err.message}\x1b[0m\n`, 'stderr');
      this.sseHub.publishStatus(projectName, { status: 'error', error: err.message });
      throw err;
    }

    taskRecord.childProcess = child;
    taskRecord.pid = child.pid;

    // Stream stdout line by line
    const rlStdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rlStdout.on('line', line => {
      this.sseHub.publishLog(projectName, line, 'stdout');
    });

    // Stream stderr line by line
    const rlStderr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    rlStderr.on('line', line => {
      this.sseHub.publishLog(projectName, line, 'stderr');
    });

    return new Promise((resolve, reject) => {
      child.on('error', err => {
        taskRecord.isFinished = true;
        this.activeTask = null;
        session.lastStatus = 'error';

        this.sseHub.publishLog(projectName, `\x1b[1;31m✖ Process error: ${err.message}\x1b[0m\n`, 'stderr');
        this.sseHub.publishStatus(projectName, { status: 'error', error: err.message, durationMs: Date.now() - startTime });
        reject(err);
      });

      child.on('close', (code, signal) => {
        taskRecord.isFinished = true;
        this.activeTask = null;
        const durationMs = Date.now() - startTime;
        const durationSec = (durationMs / 1000).toFixed(1);

        if (taskRecord.aborted) {
          session.lastStatus = 'aborted';
          this.sseHub.publishLog(
            projectName,
            `\x1b[1;33m■ Task aborted by user after ${durationSec}s\x1b[0m\n`,
            'system'
          );
          this.sseHub.publishStatus(projectName, {
            status: 'aborted',
            durationMs,
            exitCode: code,
            signal
          });
          resolve({ status: 'aborted', durationMs, exitCode: code });
        } else if (code === 0) {
          session.lastStatus = 'completed';
          this.sseHub.publishLog(
            projectName,
            `\x1b[1;32m✔ Task completed successfully in ${durationSec}s\x1b[0m\n`,
            'system'
          );
          this.sseHub.publishStatus(projectName, {
            status: 'completed',
            durationMs,
            exitCode: 0
          });
          resolve({ status: 'completed', durationMs, exitCode: 0 });
        } else {
          session.lastStatus = 'failed';
          this.sseHub.publishLog(
            projectName,
            `\x1b[1;31m✖ Process exited with code ${code} (${signal || 'none'}) after ${durationSec}s\x1b[0m\n`,
            'stderr'
          );
          this.sseHub.publishStatus(projectName, {
            status: 'failed',
            durationMs,
            exitCode: code,
            signal
          });
          resolve({ status: 'failed', durationMs, exitCode: code, signal });
        }
      });
    });
  }

  /**
   * Immediately abort the running task
   */
  async abortActiveTask() {
    if (!this.isBusy()) {
      return { success: false, message: 'No active task is running' };
    }

    const task = this.activeTask;
    task.aborted = true;

    this.sseHub.publishLog(
      task.projectName,
      `\x1b[1;33m⚠️ Immediate abort signal sent by user (SIGTERM)...\x1b[0m\n`,
      'system'
    );

    const pid = task.pid;
    if (pid) {
      try {
        // Send SIGTERM to process group (-pid)
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          task.childProcess?.kill('SIGTERM');
        } catch {}
      }

      // Hard kill fallback after 1.5s if still active
      setTimeout(() => {
        if (!task.isFinished) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            try {
              task.childProcess?.kill('SIGKILL');
            } catch {}
          }
        }
      }, 1500).unref?.();
    }

    return {
      success: true,
      message: 'Abort signal sent',
      projectName: task.projectName
    };
  }
}
