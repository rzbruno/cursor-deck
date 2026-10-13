/**
 * Cursor Agent Mobile Control Panel — Client Application
 */

class CursorAgentApp {
  constructor() {
    this.currentProject = null;
    this.projects = [];
    this.continueSession = false;
    this.currentMode = null; // null | 'plan' | 'ask'
    this.eventSource = null;
    this.lastEventId = 0;
    this.isAutoScrollEnabled = true;
    this.unreadLines = 0;
    this.wakeLock = null;
    this.isWakeLockActive = false;
    this.activeTimerInterval = null;
    this.taskStartTime = null;
    this.createMode = 'new'; // 'new' | 'clone'
    this.autoDerivedName = false;

    this.initElements();
    this.initEventListeners();
    this.initApp();
  }

  initElements() {
    // Header & Project
    this.projectBar = document.getElementById('projectSelectorBar');
    this.currentProjectNameEl = document.getElementById('currentProjectName');
    this.branchBadgeEl = document.getElementById('branchBadge');
    this.dirtyBadgeEl = document.getElementById('dirtyBadge');
    this.statusPillEl = document.getElementById('statusPill');
    this.statusTextEl = document.getElementById('statusText');
    this.wakeLockBtn = document.getElementById('wakeLockBtn');
    this.qrBtn = document.getElementById('qrBtn');

    // Tabs
    this.navTabs = document.querySelectorAll('.tab-btn');
    this.tabPanels = document.querySelectorAll('.tab-panel');

    // Console & Terminal
    this.terminalOutput = document.getElementById('terminalOutput');
    this.jumpBottomBtn = document.getElementById('jumpBottomBtn');
    this.unreadCountEl = document.getElementById('unreadCount');
    this.activeTaskBanner = document.getElementById('activeTaskBanner');
    this.bannerPromptText = document.getElementById('bannerPromptText');
    this.bannerTimer = document.getElementById('bannerTimer');
    this.abortBtn = document.getElementById('abortBtn');
    this.copyLogsBtn = document.getElementById('copyLogsBtn');
    this.clearLogsBtn = document.getElementById('clearLogsBtn');
    this.toggleWrapBtn = document.getElementById('toggleWrapBtn');

    // Prompt Dock
    this.promptTextarea = document.getElementById('promptTextarea');
    this.sendBtn = document.getElementById('sendBtn');
    this.continueToggle = document.getElementById('continueToggle');
    this.turnCountBadge = document.getElementById('turnCountBadge');
    this.modeButtons = document.querySelectorAll('.mode-option');

    // Git Status
    this.gitBranchName = document.getElementById('gitBranchName');
    this.statStaged = document.getElementById('statStaged');
    this.statModified = document.getElementById('statModified');
    this.statUntracked = document.getElementById('statUntracked');
    this.gitFileList = document.getElementById('gitFileList');
    this.stageAllBtn = document.getElementById('stageAllBtn');
    this.unstageAllBtn = document.getElementById('unstageAllBtn');
    this.commitMessageInput = document.getElementById('commitMessageInput');
    this.commitBtn = document.getElementById('commitBtn');
    this.refreshGitBtn = document.getElementById('refreshGitBtn');

    // Git Diff
    this.diffStats = document.getElementById('diffStats');
    this.diffContainer = document.getElementById('diffContainer');
    this.refreshDiffBtn = document.getElementById('refreshDiffBtn');

    // Emergency Discard
    this.emergencyDiscardBtn = document.getElementById('emergencyDiscardBtn');
    this.discardModal = document.getElementById('discardModal');
    this.confirmDiscardBtn = document.getElementById('confirmDiscardBtn');
    this.cancelDiscardBtn = document.getElementById('cancelDiscardBtn');

    // Project Modal
    this.projectModal = document.getElementById('projectModal');
    this.closeProjectModalBtn = document.getElementById('closeProjectModalBtn');
    this.projectSearchInput = document.getElementById('projectSearchInput');
    this.projectListContainer = document.getElementById('projectListContainer');
    this.refreshProjectsListBtn = document.getElementById('refreshProjectsListBtn');
    this.openCreateProjectBtn = document.getElementById('openCreateProjectBtn');

    // Create Project Modal
    this.createProjectModal = document.getElementById('createProjectModal');
    this.closeCreateProjectModalBtn = document.getElementById('closeCreateProjectModalBtn');
    this.cancelCreateProjectBtn = document.getElementById('cancelCreateProjectBtn');
    this.segmentNewBtn = document.getElementById('segmentNewBtn');
    this.segmentCloneBtn = document.getElementById('segmentCloneBtn');
    this.createProjectForm = document.getElementById('createProjectForm');
    this.createProjectError = document.getElementById('createProjectError');
    this.cloneUrlGroup = document.getElementById('cloneUrlGroup');
    this.cloneUrlInput = document.getElementById('cloneUrlInput');
    this.newProjectNameInput = document.getElementById('newProjectNameInput');
    this.projectDescGroup = document.getElementById('projectDescGroup');
    this.newProjectDescInput = document.getElementById('newProjectDescInput');
    this.localGitOptionsGroup = document.getElementById('localGitOptionsGroup');
    this.initGitCheckbox = document.getElementById('initGitCheckbox');
    this.initialCommitSubGroup = document.getElementById('initialCommitSubGroup');
    this.initialCommitCheckbox = document.getElementById('initialCommitCheckbox');
    this.submitCreateProjectBtn = document.getElementById('submitCreateProjectBtn');
    this.submitCreateText = document.getElementById('submitCreateText');
    this.submitCreateSpinner = document.getElementById('submitCreateSpinner');

    // QR Modal
    this.qrModal = document.getElementById('qrModal');
    this.closeQrModalBtn = document.getElementById('closeQrModalBtn');
    this.qrImage = document.getElementById('qrImage');
    this.qrUrlText = document.getElementById('qrUrlText');
  }

  initEventListeners() {
    // Project selector modal
    this.projectBar.addEventListener('click', () => this.openProjectModal());
    this.closeProjectModalBtn.addEventListener('click', () => this.closeProjectModal());
    this.projectModal.addEventListener('click', e => {
      if (e.target === this.projectModal) this.closeProjectModal();
    });
    this.projectSearchInput.addEventListener('input', e => this.filterProjects(e.target.value));
    this.refreshProjectsListBtn.addEventListener('click', () => this.loadProjects(true));

    // Create Project Modal triggers
    if (this.openCreateProjectBtn) {
      this.openCreateProjectBtn.addEventListener('click', () => {
        this.closeProjectModal();
        this.openCreateProjectModal();
      });
    }
    if (this.closeCreateProjectModalBtn) {
      this.closeCreateProjectModalBtn.addEventListener('click', () => this.closeCreateProjectModal());
    }
    if (this.cancelCreateProjectBtn) {
      this.cancelCreateProjectBtn.addEventListener('click', () => this.closeCreateProjectModal());
    }
    if (this.createProjectModal) {
      this.createProjectModal.addEventListener('click', e => {
        if (e.target === this.createProjectModal) this.closeCreateProjectModal();
      });
    }

    // Segments: New vs Clone
    if (this.segmentNewBtn && this.segmentCloneBtn) {
      this.segmentNewBtn.addEventListener('click', () => this.switchCreateMode('new'));
      this.segmentCloneBtn.addEventListener('click', () => this.switchCreateMode('clone'));
    }

    // Checkbox dependencies
    if (this.initGitCheckbox) {
      this.initGitCheckbox.addEventListener('change', () => {
        if (this.initialCommitSubGroup) {
          this.initialCommitSubGroup.style.display = this.initGitCheckbox.checked ? 'flex' : 'none';
        }
        if (!this.initGitCheckbox.checked && this.initialCommitCheckbox) {
          this.initialCommitCheckbox.checked = false;
        }
      });
    }

    // Auto-derive project name from clone URL
    if (this.cloneUrlInput && this.newProjectNameInput) {
      this.cloneUrlInput.addEventListener('input', () => {
        if (this.createMode === 'clone' && (!this.newProjectNameInput.value || this.autoDerivedName)) {
          const val = this.cloneUrlInput.value.trim().replace(/\/+$/, '');
          const match = val.match(/\/([^\/]+?)(\.git)?$/);
          if (match && match[1]) {
            this.newProjectNameInput.value = match[1];
            this.autoDerivedName = true;
          }
        }
      });

      this.newProjectNameInput.addEventListener('input', () => {
        this.autoDerivedName = false;
      });
    }

    // Form submission
    if (this.createProjectForm) {
      this.createProjectForm.addEventListener('submit', e => {
        e.preventDefault();
        this.submitCreateProject();
      });
    }

    // QR Modal
    this.qrBtn.addEventListener('click', () => this.openQrModal());
    this.closeQrModalBtn.addEventListener('click', () => this.closeQrModal());
    this.qrModal.addEventListener('click', e => {
      if (e.target === this.qrModal) this.closeQrModal();
    });

    // Navigation Tabs
    this.navTabs.forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    // Prompt input auto-expand
    this.promptTextarea.addEventListener('input', () => {
      this.promptTextarea.style.height = 'auto';
      this.promptTextarea.style.height = Math.min(this.promptTextarea.scrollHeight, 140) + 'px';
    });

    // Send prompt on Enter (with Ctrl/Cmd or mobile submit)
    this.promptTextarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.submitPrompt();
      }
    });

    this.sendBtn.addEventListener('click', () => this.submitPrompt());

    // Continuation toggle
    this.continueToggle.addEventListener('click', () => {
      this.continueSession = !this.continueSession;
      this.updateContinueToggleUI();
      if (this.currentProject) {
        localStorage.setItem(`continue_${this.currentProject}`, this.continueSession ? '1' : '0');
      }
    });

    // Mode Selector
    this.modeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        this.modeButtons.forEach(b => b.classList.remove('active'));
        if (this.currentMode === mode) {
          this.currentMode = null; // Toggle off
        } else {
          this.currentMode = mode;
          btn.classList.add('active');
        }
      });
    });

    // Abort Button
    this.abortBtn.addEventListener('click', () => this.abortTask());

    // Terminal controls
    this.copyLogsBtn.addEventListener('click', () => this.copyLogs());
    this.clearLogsBtn.addEventListener('click', () => this.clearLogs());
    this.toggleWrapBtn.addEventListener('click', () => {
      this.terminalOutput.classList.toggle('no-wrap');
    });

    // Terminal auto-scroll detection
    this.terminalOutput.addEventListener('scroll', () => {
      const isAtBottom = this.terminalOutput.scrollHeight - this.terminalOutput.scrollTop <= this.terminalOutput.clientHeight + 40;
      this.isAutoScrollEnabled = isAtBottom;
      if (isAtBottom) {
        this.unreadLines = 0;
        this.jumpBottomBtn.classList.remove('visible');
      }
    });

    this.jumpBottomBtn.addEventListener('click', () => {
      this.scrollToBottom();
      this.unreadLines = 0;
      this.jumpBottomBtn.classList.remove('visible');
    });

    // Screen Wake Lock API (keep phone screen on)
    this.wakeLockBtn.addEventListener('click', () => this.toggleWakeLock());

    // Git Actions
    this.refreshGitBtn.addEventListener('click', () => this.loadGitStatus());
    this.refreshDiffBtn.addEventListener('click', () => this.loadGitDiff());
    this.stageAllBtn.addEventListener('click', () => this.stageFiles([]));
    this.unstageAllBtn.addEventListener('click', () => this.unstageFiles([]));
    this.commitBtn.addEventListener('click', () => this.commitChanges());

    // Emergency Discard Modal
    this.emergencyDiscardBtn.addEventListener('click', () => {
      this.discardModal.classList.add('active');
    });
    this.cancelDiscardBtn.addEventListener('click', () => {
      this.discardModal.classList.remove('active');
    });
    this.confirmDiscardBtn.addEventListener('click', () => {
      this.discardModal.classList.remove('active');
      this.executeEmergencyDiscard();
    });

    // Handle mobile visibility change (screen lock/unlock or app switch)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // Phone unlocked or user came back to browser tab: re-verify connection
        this.checkConnectionAndTask();
        if (this.currentProject) {
          this.loadGitStatus();
        }
      }
    });
  }

  async initApp() {
    await this.checkNetworkStatus();
    await this.loadProjects();

    // Restore selected project from localStorage
    const savedProject = localStorage.getItem('selected_project');
    const matched = this.projects.find(p => p.name === savedProject);

    if (matched) {
      this.selectProject(matched.name);
    } else if (this.projects.length > 0) {
      this.selectProject(this.projects[0].name);
    }
  }

  async checkNetworkStatus() {
    try {
      const res = await fetch('/api/network');
      const data = await res.json();

      if (data.isTailscaleClient) {
        this.statusTextEl.textContent = 'Tailscale';
        this.statusPillEl.className = 'status-pill';
      } else if (data.isLocalhostClient) {
        this.statusTextEl.textContent = 'Localhost';
        this.statusPillEl.className = 'status-pill';
      } else {
        this.statusTextEl.textContent = 'Connected';
        this.statusPillEl.className = 'status-pill';
      }

      if (data.isBusy && data.activeTask) {
        this.showActiveTask(data.activeTask);
      }
    } catch {
      this.statusTextEl.textContent = 'Offline';
      this.statusPillEl.className = 'status-pill offline';
    }
  }

  async loadProjects(refresh = false) {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      this.projects = data.projects || [];
      this.renderProjectList();
    } catch (err) {
      console.error('Failed to load projects:', err);
    }
  }

  renderProjectList(filtered = null) {
    const list = filtered || this.projects;
    this.projectListContainer.innerHTML = '';

    if (list.length === 0) {
      this.projectListContainer.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted)">No projects found</div>`;
      return;
    }

    list.forEach(project => {
      const item = document.createElement('div');
      item.className = `project-item ${project.name === this.currentProject ? 'selected' : ''}`;

      const left = document.createElement('div');
      left.innerHTML = `
        <div class="project-item-title">${this.escape(project.name)}</div>
        <div style="font-size:0.75rem;color:var(--text-muted);display:flex;gap:6px;margin-top:2px;">
          <span>${project.branch ? '🌿 ' + this.escape(project.branch) : '📁 project'}</span>
          ${project.dirtyCount > 0 ? `<span style="color:#fbbf24">• ${project.dirtyCount} modified</span>` : ''}
        </div>
      `;

      item.appendChild(left);
      item.addEventListener('click', () => {
        this.selectProject(project.name);
        this.closeProjectModal();
      });

      this.projectListContainer.appendChild(item);
    });
  }

  filterProjects(query) {
    const q = query.toLowerCase().trim();
    if (!q) {
      this.renderProjectList();
      return;
    }
    const filtered = this.projects.filter(p => p.name.toLowerCase().includes(q));
    this.renderProjectList(filtered);
  }

  openProjectModal() {
    this.projectSearchInput.value = '';
    this.renderProjectList();
    this.projectModal.classList.add('active');
    setTimeout(() => this.projectSearchInput.focus(), 100);
  }

  closeProjectModal() {
    this.projectModal.classList.remove('active');
  }

  /* --------------------------------------------------------------------------
     Create Project Modal Handling
     -------------------------------------------------------------------------- */
  openCreateProjectModal() {
    this.createMode = 'new';
    this.autoDerivedName = false;
    if (this.createProjectError) {
      this.createProjectError.style.display = 'none';
      this.createProjectError.textContent = '';
    }
    if (this.newProjectNameInput) this.newProjectNameInput.value = '';
    if (this.newProjectDescInput) this.newProjectDescInput.value = '';
    if (this.cloneUrlInput) this.cloneUrlInput.value = '';
    if (this.initGitCheckbox) this.initGitCheckbox.checked = true;
    if (this.initialCommitCheckbox) this.initialCommitCheckbox.checked = true;
    if (this.initialCommitSubGroup) this.initialCommitSubGroup.style.display = 'flex';

    this.switchCreateMode('new');
    if (this.createProjectModal) {
      this.createProjectModal.classList.add('active');
    }
    if (this.newProjectNameInput) {
      setTimeout(() => this.newProjectNameInput.focus(), 120);
    }
  }

  closeCreateProjectModal() {
    if (this.createProjectModal) {
      this.createProjectModal.classList.remove('active');
    }
  }

  switchCreateMode(mode) {
    this.createMode = mode;
    if (this.createProjectError) {
      this.createProjectError.style.display = 'none';
    }

    if (mode === 'new') {
      if (this.segmentNewBtn) {
        this.segmentNewBtn.classList.add('active');
        this.segmentNewBtn.setAttribute('aria-selected', 'true');
      }
      if (this.segmentCloneBtn) {
        this.segmentCloneBtn.classList.remove('active');
        this.segmentCloneBtn.setAttribute('aria-selected', 'false');
      }
      if (this.cloneUrlGroup) this.cloneUrlGroup.style.display = 'none';
      if (this.projectDescGroup) this.projectDescGroup.style.display = 'flex';
      if (this.localGitOptionsGroup) this.localGitOptionsGroup.style.display = 'flex';
      if (this.submitCreateText) this.submitCreateText.textContent = 'Create Project';
    } else {
      if (this.segmentCloneBtn) {
        this.segmentCloneBtn.classList.add('active');
        this.segmentCloneBtn.setAttribute('aria-selected', 'true');
      }
      if (this.segmentNewBtn) {
        this.segmentNewBtn.classList.remove('active');
        this.segmentNewBtn.setAttribute('aria-selected', 'false');
      }
      if (this.cloneUrlGroup) this.cloneUrlGroup.style.display = 'flex';
      if (this.projectDescGroup) this.projectDescGroup.style.display = 'none';
      if (this.localGitOptionsGroup) this.localGitOptionsGroup.style.display = 'none';
      if (this.submitCreateText) this.submitCreateText.textContent = 'Clone Repository';
    }
  }

  async submitCreateProject() {
    const name = this.newProjectNameInput ? this.newProjectNameInput.value.trim() : '';
    const cloneUrl = this.cloneUrlInput ? this.cloneUrlInput.value.trim() : '';
    const description = this.newProjectDescInput ? this.newProjectDescInput.value.trim() : '';
    const initGit = this.initGitCheckbox ? this.initGitCheckbox.checked : true;
    const initialCommit = this.initialCommitCheckbox ? this.initialCommitCheckbox.checked : true;

    if (this.createMode === 'clone' && !cloneUrl) {
      this.showCreateError('Please provide a Git repository URL to clone');
      if (this.cloneUrlInput) this.cloneUrlInput.focus();
      return;
    }

    if (!name) {
      this.showCreateError('Please provide a project name');
      if (this.newProjectNameInput) this.newProjectNameInput.focus();
      return;
    }

    // Set loading state
    if (this.submitCreateProjectBtn) this.submitCreateProjectBtn.disabled = true;
    if (this.submitCreateSpinner) this.submitCreateSpinner.style.display = 'inline-block';
    if (this.submitCreateText) this.submitCreateText.style.display = 'none';
    if (this.createProjectError) this.createProjectError.style.display = 'none';

    try {
      const payload = {
        name,
        initGit: this.createMode === 'new' ? initGit : true,
        cloneUrl: this.createMode === 'clone' ? cloneUrl : null,
        description: this.createMode === 'new' ? description : '',
        initialCommit: this.createMode === 'new' ? initialCommit : true
      };

      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to create project');
      }

      // Success! Close modal and refresh projects
      this.closeCreateProjectModal();
      await this.loadProjects();

      // Automatically select and switch into the new project
      if (data.project && data.project.name) {
        await this.selectProject(data.project.name);
      }
      this.switchTab('console');
    } catch (err) {
      this.showCreateError(err.message);
    } finally {
      if (this.submitCreateProjectBtn) this.submitCreateProjectBtn.disabled = false;
      if (this.submitCreateSpinner) this.submitCreateSpinner.style.display = 'none';
      if (this.submitCreateText) this.submitCreateText.style.display = 'inline';
    }
  }

  showCreateError(msg) {
    if (this.createProjectError) {
      this.createProjectError.textContent = msg;
      this.createProjectError.style.display = 'block';
    }
  }

  async selectProject(projectName) {
    this.currentProject = projectName;
    localStorage.setItem('selected_project', projectName);

    const project = this.projects.find(p => p.name === projectName) || { name: projectName };
    this.currentProjectNameEl.textContent = project.name;

    // Load saved continuation state for this project
    const savedCont = localStorage.getItem(`continue_${projectName}`);
    this.continueSession = savedCont === '1';
    this.updateContinueToggleUI();

    // Connect SSE stream
    this.connectEventSource(projectName);

    // Refresh Git Status & Diff
    this.loadGitStatus();
    this.loadGitDiff();

    // Check project session
    this.loadSessionInfo();
  }

  async loadSessionInfo() {
    if (!this.currentProject) return;
    try {
      const res = await fetch(`/api/session?project=${encodeURIComponent(this.currentProject)}`);
      const data = await res.json();
      if (data.turnCount > 0) {
        this.turnCountBadge.textContent = `Turn ${data.turnCount}`;
        this.turnCountBadge.style.display = 'inline';
      } else {
        this.turnCountBadge.style.display = 'none';
      }
    } catch {}
  }

  updateContinueToggleUI() {
    if (this.continueSession) {
      this.continueToggle.classList.add('active');
    } else {
      this.continueToggle.classList.remove('active');
    }
  }

  /* --------------------------------------------------------------------------
     Server-Sent Events (SSE) Stream
     -------------------------------------------------------------------------- */
  connectEventSource(projectName) {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    // Clear terminal on project switch
    this.terminalOutput.innerHTML = '';
    this.lastEventId = 0;

    const streamUrl = `/api/stream?project=${encodeURIComponent(projectName)}&lastEventId=${this.lastEventId}`;
    this.eventSource = new EventSource(streamUrl);

    this.eventSource.addEventListener('log', e => {
      try {
        const data = JSON.parse(e.data);
        this.lastEventId = data.id || this.lastEventId;
        this.appendLog(data);
      } catch (err) {
        console.error('Failed to parse log event:', err);
      }
    });

    this.eventSource.addEventListener('status', e => {
      try {
        const data = JSON.parse(e.data);
        this.handleStatusUpdate(data);
      } catch (err) {
        console.error('Failed to parse status event:', err);
      }
    });

    this.eventSource.addEventListener('clear', () => {
      this.terminalOutput.innerHTML = '';
    });

    this.eventSource.onopen = () => {
      this.statusPillEl.className = 'status-pill';
    };

    this.eventSource.onerror = () => {
      // EventSource automatically attempts to reconnect on mobile network changes
      this.statusPillEl.className = 'status-pill offline';
    };
  }

  appendLog(data) {
    const line = document.createElement('div');
    line.className = `log-line stream-${data.stream || 'stdout'}`;
    line.innerHTML = data.html || this.escape(data.text);

    this.terminalOutput.appendChild(line);

    if (this.isAutoScrollEnabled) {
      this.scrollToBottom();
    } else {
      this.unreadLines++;
      this.unreadCountEl.textContent = this.unreadLines;
      this.jumpBottomBtn.classList.add('visible');
    }
  }

  scrollToBottom() {
    this.terminalOutput.scrollTop = this.terminalOutput.scrollHeight;
    this.isAutoScrollEnabled = true;
  }

  handleStatusUpdate(data) {
    if (data.status === 'running') {
      this.showActiveTask(data);
    } else {
      this.hideActiveTask();
      this.loadGitStatus();
      this.loadGitDiff();
      this.loadSessionInfo();

      // Mobile haptic vibration feedback
      if ('vibrate' in navigator) {
        if (data.status === 'completed') {
          navigator.vibrate([100, 50, 100]);
        } else if (data.status === 'failed' || data.status === 'error') {
          navigator.vibrate([250]);
        }
      }
    }
  }

  showActiveTask(task) {
    this.activeTaskBanner.classList.add('visible');
    this.bannerPromptText.textContent = task.prompt || 'Running task...';
    this.sendBtn.disabled = true;

    this.taskStartTime = task.startTime || Date.now();
    clearInterval(this.activeTimerInterval);
    this.activeTimerInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - this.taskStartTime) / 1000);
      const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
      const secs = String(elapsedSec % 60).padStart(2, '0');
      this.bannerTimer.textContent = `${mins}:${secs}`;
    }, 1000);
  }

  hideActiveTask() {
    this.activeTaskBanner.classList.remove('visible');
    this.sendBtn.disabled = false;
    clearInterval(this.activeTimerInterval);
  }

  async checkConnectionAndTask() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      if (data.isBusy && data.activeTask) {
        this.showActiveTask(data.activeTask);
      } else {
        this.hideActiveTask();
      }
    } catch {}
  }

  /* --------------------------------------------------------------------------
     Prompt Submission & Abort
     -------------------------------------------------------------------------- */
  async submitPrompt() {
    const prompt = this.promptTextarea.value.trim();
    if (!prompt || !this.currentProject) return;

    this.sendBtn.disabled = true;
    this.promptTextarea.value = '';
    this.promptTextarea.style.height = 'auto';

    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: this.currentProject,
          prompt,
          continueSession: this.continueSession,
          mode: this.currentMode
        })
      });

      if (!res.ok) {
        const err = await res.json();
        alert(err.message || 'Failed to start task');
        this.sendBtn.disabled = false;
      } else {
        // Turn on continuation automatically for next message in conversation
        this.continueSession = true;
        this.updateContinueToggleUI();
        localStorage.setItem(`continue_${this.currentProject}`, '1');
      }
    } catch (err) {
      alert('Network error submitting prompt: ' + err.message);
      this.sendBtn.disabled = false;
    }
  }

  async abortTask() {
    try {
      const res = await fetch('/api/abort', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        alert(data.message || 'No task to abort');
      }
    } catch (err) {
      alert('Error sending abort signal: ' + err.message);
    }
  }

  async clearLogs() {
    if (!this.currentProject) return;
    try {
      await fetch(`/api/logs?project=${encodeURIComponent(this.currentProject)}`, { method: 'DELETE' });
      this.terminalOutput.innerHTML = '';
    } catch {}
  }

  async copyLogs() {
    const text = this.terminalOutput.innerText;
    try {
      await navigator.clipboard.writeText(text);
      const prevText = this.copyLogsBtn.innerHTML;
      this.copyLogsBtn.innerHTML = '✔ Copied';
      setTimeout(() => (this.copyLogsBtn.innerHTML = prevText), 1500);
    } catch {
      alert('Unable to copy to clipboard');
    }
  }

  /* --------------------------------------------------------------------------
     Screen Wake Lock (Keep phone screen awake)
     -------------------------------------------------------------------------- */
  async toggleWakeLock() {
    if ('wakeLock' in navigator) {
      if (this.isWakeLockActive) {
        if (this.wakeLock) {
          await this.wakeLock.release();
          this.wakeLock = null;
        }
        this.isWakeLockActive = false;
        this.wakeLockBtn.classList.remove('active');
      } else {
        try {
          this.wakeLock = await navigator.wakeLock.request('screen');
          this.isWakeLockActive = true;
          this.wakeLockBtn.classList.add('active');
          this.wakeLock.addEventListener('release', () => {
            this.isWakeLockActive = false;
            this.wakeLockBtn.classList.remove('active');
          });
        } catch (err) {
          console.warn('Wake Lock error:', err);
        }
      }
    } else {
      alert('Screen Wake Lock is not supported by this browser.');
    }
  }

  /* --------------------------------------------------------------------------
     Local Git Controls (Status, Diff, Commit, Discard)
     -------------------------------------------------------------------------- */
  async loadGitStatus() {
    if (!this.currentProject) return;
    try {
      const res = await fetch(`/api/git/status?project=${encodeURIComponent(this.currentProject)}`);
      const data = await res.json();

      if (!data.isGit) {
        this.branchBadgeEl.textContent = 'non-git';
        this.dirtyBadgeEl.style.display = 'none';
        this.gitBranchName.textContent = 'Not a git repository';
        this.gitFileList.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted)">Project is not a git repository</div>';
        return;
      }

      this.branchBadgeEl.textContent = data.branch;
      this.gitBranchName.textContent = `🌿 ${data.branch}${data.ahead ? ` [ahead ${data.ahead}]` : ''}`;

      // Update dirty badge
      if (data.stats.total > 0) {
        this.dirtyBadgeEl.textContent = `${data.stats.total} modified`;
        this.dirtyBadgeEl.className = 'badge badge-dirty';
        this.dirtyBadgeEl.style.display = 'inline';
      } else {
        this.dirtyBadgeEl.textContent = 'Clean';
        this.dirtyBadgeEl.className = 'badge badge-clean';
        this.dirtyBadgeEl.style.display = 'inline';
      }

      this.statStaged.textContent = `${data.stats.staged} staged`;
      this.statModified.textContent = `${data.stats.unstaged} modified`;
      this.statUntracked.textContent = `${data.stats.untracked} untracked`;

      // Render files
      this.renderGitFiles(data.files);
    } catch (err) {
      console.error('Git status error:', err);
    }
  }

  renderGitFiles(files) {
    this.gitFileList.innerHTML = '';
    if (!files || files.length === 0) {
      this.gitFileList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">Working directory clean ✨</div>';
      return;
    }

    files.forEach(f => {
      const item = document.createElement('div');
      item.className = 'file-item';

      const tagColor = f.category === 'added' ? '#34d399' :
                       f.category === 'deleted' ? '#f87171' :
                       f.category === 'untracked' ? '#94a3b8' : '#fbbf24';

      const tagLetter = f.category === 'added' ? 'A' :
                        f.category === 'deleted' ? 'D' :
                        f.category === 'untracked' ? '?' : 'M';

      item.innerHTML = `
        <div class="file-left">
          <span class="file-status-tag" style="color:${tagColor}">${tagLetter}</span>
          <span class="file-path">${this.escape(f.path)}</span>
        </div>
        <div class="file-actions">
          <button class="tool-btn" data-path="${this.escape(f.path)}">${f.isStaged ? 'Unstage' : 'Stage'}</button>
        </div>
      `;

      const btn = item.querySelector('.tool-btn');
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (f.isStaged) {
          this.unstageFiles([f.path]);
        } else {
          this.stageFiles([f.path]);
        }
      });

      // Clicking file opens Diff tab
      item.addEventListener('click', () => {
        this.switchTab('diff');
        this.loadGitDiff(f.path);
      });

      this.gitFileList.appendChild(item);
    });
  }

  async stageFiles(files) {
    if (!this.currentProject) return;
    try {
      await fetch('/api/git/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: this.currentProject, files })
      });
      this.loadGitStatus();
      this.loadGitDiff();
    } catch (err) {
      alert('Failed to stage: ' + err.message);
    }
  }

  async unstageFiles(files) {
    if (!this.currentProject) return;
    try {
      await fetch('/api/git/unstage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: this.currentProject, files })
      });
      this.loadGitStatus();
      this.loadGitDiff();
    } catch (err) {
      alert('Failed to unstage: ' + err.message);
    }
  }

  async commitChanges() {
    const msg = this.commitMessageInput.value.trim();
    if (!msg || !this.currentProject) return;

    this.commitBtn.disabled = true;
    try {
      const res = await fetch('/api/git/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: this.currentProject, message: msg, stageAll: true })
      });

      if (res.ok) {
        this.commitMessageInput.value = '';
        this.loadGitStatus();
        this.loadGitDiff();
      } else {
        const err = await res.json();
        alert(err.message || 'Commit failed');
      }
    } catch (err) {
      alert('Commit failed: ' + err.message);
    } finally {
      this.commitBtn.disabled = false;
    }
  }

  async loadGitDiff(filePath = null) {
    if (!this.currentProject) return;
    try {
      const url = `/api/git/diff?project=${encodeURIComponent(this.currentProject)}${filePath ? `&file=${encodeURIComponent(filePath)}` : ''}`;
      const res = await fetch(url);
      const data = await res.json();

      this.diffStats.innerHTML = `
        <span class="diff-add">+${data.stats.additions}</span>
        <span class="diff-del">-${data.stats.deletions}</span>
        <span style="color:var(--text-muted)">across ${data.stats.filesChanged} file${data.stats.filesChanged === 1 ? '' : 's'}</span>
      `;

      this.renderDiff(data.files);
    } catch (err) {
      console.error('Git diff error:', err);
    }
  }

  renderDiff(files) {
    this.diffContainer.innerHTML = '';
    if (!files || files.length === 0) {
      this.diffContainer.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted)">No uncommitted changes in HEAD</div>';
      return;
    }

    files.forEach(f => {
      const card = document.createElement('div');
      card.className = 'diff-file-card';

      let hunksHtml = '';
      f.hunks.forEach(h => {
        hunksHtml += `<div class="diff-line hunk">${this.escape(h.header)}</div>`;
        h.lines.forEach(l => {
          const typeClass = l.type === 'add' ? 'add' : l.type === 'del' ? 'del' : 'ctx';
          const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
          hunksHtml += `<div class="diff-line ${typeClass}">${prefix}${this.escape(l.content)}</div>`;
        });
      });

      card.innerHTML = `
        <div class="diff-file-header">
          <span>📄 ${this.escape(f.fileName)}</span>
          <span><span class="diff-add">+${f.additions}</span> <span class="diff-del">-${f.deletions}</span></span>
        </div>
        <div class="diff-content">${hunksHtml}</div>
      `;

      this.diffContainer.appendChild(card);
    });
  }

  async executeEmergencyDiscard() {
    if (!this.currentProject) return;
    try {
      const res = await fetch('/api/git/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: this.currentProject })
      });

      if (res.ok) {
        this.loadGitStatus();
        this.loadGitDiff();
        this.switchTab('console');
      } else {
        const err = await res.json();
        alert('Emergency discard error: ' + err.message);
      }
    } catch (err) {
      alert('Emergency discard network error: ' + err.message);
    }
  }

  /* --------------------------------------------------------------------------
     QR Modal
     -------------------------------------------------------------------------- */
  async openQrModal() {
    try {
      const res = await fetch('/api/qr');
      const data = await res.json();
      this.qrImage.src = data.dataUrl;
      this.qrUrlText.textContent = data.url;
      this.qrModal.classList.add('active');
    } catch (err) {
      alert('Failed to load QR code: ' + err.message);
    }
  }

  closeQrModal() {
    this.qrModal.classList.remove('active');
  }

  /* --------------------------------------------------------------------------
     Tab Navigation
     -------------------------------------------------------------------------- */
  switchTab(tabName) {
    this.navTabs.forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tabName);
    });
    this.tabPanels.forEach(p => {
      p.classList.toggle('active', p.id === `${tabName}Panel`);
    });

    if (tabName === 'status') this.loadGitStatus();
    if (tabName === 'diff') this.loadGitDiff();
    if (tabName === 'console' && this.isAutoScrollEnabled) this.scrollToBottom();
  }

  escape(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

// Instantiate on DOM load
window.addEventListener('DOMContentLoaded', () => {
  window.cursorApp = new CursorAgentApp();
});
