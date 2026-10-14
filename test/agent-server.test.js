import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';

import { ansiToHtml, stripAnsi } from '../src/ansi-parser.js';
import { isTailscaleIp, isTailscaleIpv4, isLocalhost } from '../src/tailscale.js';
import { ProjectManager } from '../src/project-manager.js';
import { SseHub } from '../src/sse-hub.js';
import { GitManager } from '../src/git-manager.js';
import { AgentServer } from '../src/server.js';
import { ProcessManager } from '../src/process-manager.js';

test('ansi-parser: strips ANSI sequences cleanly', () => {
  const input = '\x1b[32m✔ Success\x1b[0m \x1b[1mBold Text\x1b[0m\r\n';
  const stripped = stripAnsi(input);
  assert.equal(stripped, '✔ Success Bold Text\n');
});

test('ansi-parser: converts ANSI codes to styled HTML spans', () => {
  const input = '\x1b[31mError message\x1b[0m';
  const html = ansiToHtml(input);
  assert.ok(html.includes('class="color-red"'));
  assert.ok(html.includes('Error message'));
});

test('tailscale: correctly detects Tailscale CGNAT IP range (100.64.0.0/10)', () => {
  // Valid Tailscale IPs
  assert.equal(isTailscaleIpv4('100.64.0.1'), true);
  assert.equal(isTailscaleIpv4('100.100.50.25'), true);
  assert.equal(isTailscaleIpv4('100.127.255.254'), true);
  assert.equal(isTailscaleIp('100.85.120.4'), true);

  // Invalid / LAN / Non-Tailscale IPs
  assert.equal(isTailscaleIpv4('100.63.255.255'), false); // Below 64
  assert.equal(isTailscaleIpv4('100.128.0.1'), false);     // Above 127
  assert.equal(isTailscaleIpv4('192.168.1.50'), false);
  assert.equal(isTailscaleIpv4('127.0.0.1'), false);
  assert.equal(isTailscaleIpv4('10.0.0.1'), false);

  // Localhost checks
  assert.equal(isLocalhost('127.0.0.1'), true);
  assert.equal(isLocalhost('::1'), true);
  assert.equal(isLocalhost('::ffff:127.0.0.1'), true);
  assert.equal(isLocalhost('192.168.1.14'), false);
});

test('project-manager: target scoping & path traversal defense', async () => {
  const pm = new ProjectManager('/home/user/code');

  // Valid project
  const validPath = pm.resolveSafeProjectPath('cursor-deck');
  assert.equal(validPath, '/home/user/code/cursor-deck');

  // Traversal attempts must throw security violation
  assert.throws(() => pm.resolveSafeProjectPath('../'), /Invalid project name|traversal attempt/);
  assert.throws(() => pm.resolveSafeProjectPath('../../etc/passwd'), /Invalid project name|traversal attempt/);
  assert.throws(() => pm.resolveSafeProjectPath('cursor-deck/../../etc'), /Invalid project name|traversal attempt/);
  assert.throws(() => pm.resolveSafeProjectPath('nonexistent-proj-xyz-123'), /does not exist/);
});

test('sse-hub: ring buffer and replay for reconnecting mobile devices', () => {
  const sse = new SseHub({ bufferCapacity: 10 });

  // Publish 5 events
  for (let i = 1; i <= 5; i++) {
    sse.publishLog('projA', `Line ${i}`);
  }

  const logs = sse.getProjectLogs('projA');
  assert.equal(logs.length, 5);
  assert.equal(logs[0].text, 'Line 1');
  assert.equal(logs[4].text, 'Line 5');

  // Check replay
  let replayed = [];
  const fakeRes = {
    writeHead: () => {},
    write: chunk => {
      const match = chunk.match(/data:\s*({.*})/);
      if (match) {
        try {
          const json = JSON.parse(match[1]);
          replayed.push(json);
        } catch {}
      }
    }
  };
  const fakeReq = { on: () => {} };

  // Connect asking for events after ID 3
  sse.handleConnection(fakeReq, fakeRes, 'projA', 3);
  const logReplays = replayed.filter(r => r.type === 'log');
  assert.equal(logReplays.length, 2);
  assert.equal(logReplays[0].text, 'Line 4');
  assert.equal(logReplays[1].text, 'Line 5');

  sse.destroy();
});

test('git-manager: parsed diff', () => {
  const gm = new GitManager({
    projectManager: new ProjectManager('/home/user/code'),
    sseHub: new SseHub()
  });

  const sampleDiff = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
`;

  const parsed = gm.parseUnifiedDiff(sampleDiff);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].fileName, 'index.js');
  assert.equal(parsed[0].additions, 2);
  assert.equal(parsed[0].deletions, 1);
});

test('server: starts, serves static assets and API correctly', async () => {
  const server = new AgentServer({
    rootDir: '/home/user/code',
    port: 4899,
    host: '127.0.0.1'
  });

  await server.start();

  try {
    // 1. Static HTML
    const htmlRes = await fetch('http://127.0.0.1:4899/');
    assert.equal(htmlRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('Cursor Deck'));

    // 2. Network info API
    const netRes = await fetch('http://127.0.0.1:4899/api/network');
    assert.equal(netRes.status, 200);
    const netData = await netRes.json();
    assert.equal(netData.port, 4899);
    assert.equal(netData.isLocalhostClient, true);

    // 3. Projects API
    const projRes = await fetch('http://127.0.0.1:4899/api/projects');
    assert.equal(projRes.status, 200);
    const projData = await projRes.json();
    assert.ok(projData.count > 0);
    const hasCurrent = projData.projects.some(p => p.name === 'cursor-deck');
    assert.equal(hasCurrent, true);

    // 4. Git status API
    const gitRes = await fetch('http://127.0.0.1:4899/api/git/status?project=cursor-deck');
    assert.equal(gitRes.status, 200);
    const gitData = await gitRes.json();
    assert.ok('isGit' in gitData);

    // 5. QR API
    const qrRes = await fetch('http://127.0.0.1:4899/api/qr');
    assert.equal(qrRes.status, 200);
    const qrData = await qrRes.json();
    assert.ok(qrData.dataUrl.startsWith('data:image/png;base64,'));

  } finally {
    await server.stop();
  }
});

test('server: enforces Tailscale-only security when enabled', async () => {
  const server = new AgentServer({
    rootDir: '/home/user/code',
    port: 4898,
    host: '127.0.0.1',
    tailscaleOnly: true
  });

  await server.start();

  try {
    // Localhost request is allowed
    const localRes = await fetch('http://127.0.0.1:4898/api/network');
    assert.equal(localRes.status, 200);

    // Simulated external non-tailscale IP via header or remote address check
    const forbiddenRes = await fetch('http://127.0.0.1:4898/api/network', {
      headers: { 'X-Forwarded-For': '203.0.113.195' }
    });
    assert.equal(forbiddenRes.status, 403);
    const forbiddenData = await forbiddenRes.json();
    assert.equal(forbiddenData.error, 'Forbidden');
    assert.ok(forbiddenData.message.includes('Tailscale'));

    // Simulated Tailscale IP request is allowed
    const tsRes = await fetch('http://127.0.0.1:4898/api/network', {
      headers: { 'X-Forwarded-For': '100.100.45.22' }
    });
    assert.equal(tsRes.status, 200);
  } finally {
    await server.stop();
  }
});

test('process-manager: locking rejects overlapping concurrent runs with 409', async () => {
  const pm = new AgentServer({
    rootDir: '/home/user/code',
    port: 4897,
    host: '127.0.0.1',
    agentCmd: 'node' // use node as test runner
  });

  const procMgr = pm.processManager;

  // Mock running task
  procMgr.activeTask = {
    projectName: 'cursor-deck',
    prompt: 'long running task',
    startTime: Date.now(),
    isFinished: false
  };

  assert.equal(procMgr.isBusy(), true);

  // Trying to run another task while busy must throw 409
  await assert.rejects(
    async () => {
      await procMgr.runTask({
        projectName: 'cursor-deck',
        prompt: 'second task'
      });
    },
    err => {
      assert.equal(err.status, 409);
      assert.ok(err.message.includes('Process locked'));
      return true;
    }
  );

  // Abort test
  const abortRes = await procMgr.abortActiveTask();
  assert.equal(abortRes.success, true);
  assert.equal(abortRes.projectName, 'cursor-deck');

  procMgr.activeTask = null;
  assert.equal(procMgr.isBusy(), false);
});

test('project-manager: validateNewProjectName validates name format, boundaries, and duplicates', async () => {
  const pm = new ProjectManager('/home/user/code');

  // Valid names
  const valid = pm.validateNewProjectName('brand-new-app');
  assert.equal(valid.cleanName, 'brand-new-app');
  assert.equal(valid.resolvedPath, '/home/user/code/brand-new-app');

  // Existing project must throw 409
  assert.throws(
    () => pm.validateNewProjectName('cursor-deck'),
    err => {
      assert.equal(err.status, 409);
      assert.ok(err.message.includes('already exists'));
      return true;
    }
  );

  // Traversal & invalid formats must throw 400
  assert.throws(() => pm.validateNewProjectName('../other'), err => err.status === 400);
  assert.throws(() => pm.validateNewProjectName('has space'), err => err.status === 400);
  assert.throws(() => pm.validateNewProjectName('-starts-with-dash'), err => err.status === 400);
  assert.throws(() => pm.validateNewProjectName(''), err => err.status === 400);
});

test('project-manager: creates a local project with git, readme, and gitignore', async () => {
  const testRoot = path.resolve(process.cwd(), '.test-tmp-pm');
  await fs.mkdir(testRoot, { recursive: true });

  const pm = new ProjectManager(testRoot);

  try {
    const proj = await pm.createProject({
      name: 'hello-world',
      description: 'Test project description',
      initGit: true,
      initialCommit: true
    });

    assert.equal(proj.name, 'hello-world');
    assert.equal(proj.isGit, true);
    assert.equal(proj.branch, 'main');
    assert.ok(proj.lastCommit);
    assert.equal(proj.lastCommit.msg, 'Initial commit');

    // Check files created on disk
    const readme = await fs.readFile(path.join(testRoot, 'hello-world', 'README.md'), 'utf8');
    assert.ok(readme.includes('# hello-world'));
    assert.ok(readme.includes('Test project description'));

    const gitignore = await fs.readFile(path.join(testRoot, 'hello-world', '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('node_modules/'));

    // Creating again must fail with 409
    await assert.rejects(
      async () => {
        await pm.createProject({ name: 'hello-world' });
      },
      err => {
        assert.equal(err.status, 409);
        return true;
      }
    );

    // Test cloning this project into a new one
    const cloned = await pm.createProject({
      name: 'cloned-world',
      cloneUrl: `file://${path.join(testRoot, 'hello-world')}`
    });

    assert.equal(cloned.name, 'cloned-world');
    assert.equal(cloned.isGit, true);
  } finally {
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('server: POST /api/projects creates new project and returns 201 Created', async () => {
  const testRoot = path.resolve(process.cwd(), '.test-tmp-server');
  await fs.mkdir(testRoot, { recursive: true });

  const server = new AgentServer({
    rootDir: testRoot,
    port: 4895,
    host: '127.0.0.1'
  });

  await server.start();

  try {
    // 1. Create a new project via POST /api/projects
    const createRes = await fetch('http://127.0.0.1:4895/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test-backend-api',
        description: 'Created through REST API',
        initGit: true,
        initialCommit: true
      })
    });

    assert.equal(createRes.status, 201);
    const createData = await createRes.json();
    assert.equal(createData.success, true);
    assert.equal(createData.project.name, 'test-backend-api');
    assert.equal(createData.project.isGit, true);

    // 2. Verify it is listed in GET /api/projects
    const listRes = await fetch('http://127.0.0.1:4895/api/projects');
    const listData = await listRes.json();
    assert.equal(listData.count, 1);
    assert.equal(listData.projects[0].name, 'test-backend-api');

    // 3. Duplicate name attempt returns 409 Conflict
    const dupRes = await fetch('http://127.0.0.1:4895/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-backend-api' })
    });
    assert.equal(dupRes.status, 409);
    const dupData = await dupRes.json();
    assert.ok(dupData.message.includes('already exists'));

    // 4. Invalid name returns 400 Bad Request
    const invalidRes = await fetch('http://127.0.0.1:4895/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '../bad/path' })
    });
    assert.equal(invalidRes.status, 400);
  } finally {
    await server.stop();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('process-manager: handles explicit execution modes (agent, plan, ask)', async () => {
  const pm = new AgentServer({
    rootDir: '/home/user/code',
    port: 4894,
    host: '127.0.0.1',
    agentCmd: 'node'
  });

  const procMgr = pm.processManager;

  procMgr.activeTask = {
    projectName: 'cursor-deck',
    prompt: 'run agent tasks',
    startTime: Date.now(),
    mode: 'agent',
    isFinished: false
  };

  const infoAgent = procMgr.getActiveTaskInfo();
  assert.equal(infoAgent.mode, 'agent');

  procMgr.activeTask.mode = 'plan';
  const infoPlan = procMgr.getActiveTaskInfo();
  assert.equal(infoPlan.mode, 'plan');

  procMgr.activeTask.mode = 'ask';
  const infoAsk = procMgr.getActiveTaskInfo();
  assert.equal(infoAsk.mode, 'ask');

  procMgr.activeTask = null;
});

test('process-manager: handles model selection, parsing, and provider detection', async () => {
  const pm = new AgentServer({
    rootDir: '/home/user/code',
    port: 4895,
    host: '127.0.0.1',
    agentCmd: 'agent'
  });

  const procMgr = pm.processManager;

  // Active task model tracking
  procMgr.activeTask = {
    projectName: 'cursor-deck',
    prompt: 'model test prompt',
    startTime: Date.now(),
    mode: 'agent',
    model: 'claude-sonnet-5-thinking-high',
    isFinished: false
  };

  const info = procMgr.getActiveTaskInfo();
  assert.equal(info.model, 'claude-sonnet-5-thinking-high');

  // Provider detection
  assert.equal(procMgr.detectModelProvider('claude-sonnet-5', 'Claude Sonnet 5'), 'Anthropic');
  assert.equal(procMgr.detectModelProvider('gpt-5.2', 'GPT-5.2'), 'OpenAI');
  assert.equal(procMgr.detectModelProvider('gemini-3.8-flash-high', 'Gemini 3.8 Flash High'), 'Google');
  assert.equal(procMgr.detectModelProvider('cursor-grok-4.5', 'Grok 4.5'), 'xAI');
  assert.equal(procMgr.detectModelProvider('composer-2.5', 'Composer 2.5'), 'Cursor');

  // Parsing CLI output
  const sampleCliOutput = `
Available models

auto - Auto (current, default)
gpt-5.3-codex - Codex 5.3
claude-sonnet-5-thinking-high - Claude Sonnet 5 1M Thinking
gemini-3.8-flash-high - Gemini 3.8 Flash High
Tip: use --model <id> to switch.
`;

  const parsed = procMgr.parseModelsOutput(sampleCliOutput);
  assert.ok(parsed.length >= 4);
  assert.equal(parsed[0].id, 'auto');
  assert.equal(parsed[0].isDefault, true);
  assert.equal(parsed.find(m => m.id === 'claude-sonnet-5-thinking-high')?.provider, 'Anthropic');
  assert.equal(parsed.find(m => m.id === 'gpt-5.3-codex')?.provider, 'OpenAI');
  assert.equal(parsed.find(m => m.id === 'gemini-3.8-flash-high')?.provider, 'Google');

  // Available models returns valid list
  const models = await procMgr.getAvailableModels();
  assert.ok(Array.isArray(models));
  assert.ok(models.length > 0);

  // Discards fallback models: throws error if CLI fails
  const failingProcMgr = new ProcessManager({ agentCmd: 'non-existent-agent-cmd-xyz' });
  await assert.rejects(
    async () => {
      await failingProcMgr.getAvailableModels();
    },
    /Failed to retrieve models from Cursor CLI/
  );

  procMgr.activeTask = null;
});

test('server: GET /api/models returns 200 with available model list', async () => {
  const testRoot = path.join('/home/user/code', 'test-models-env-' + Date.now());
  await fs.mkdir(testRoot, { recursive: true });

  const server = new AgentServer({
    rootDir: testRoot,
    port: 4896,
    host: '127.0.0.1',
    agentCmd: 'agent'
  });

  try {
    await server.start();

    const res = await fetch('http://127.0.0.1:4896/api/models');
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.ok(data.count > 0);
    assert.ok(Array.isArray(data.models));
    assert.equal(data.default, 'auto');
    assert.ok(data.models.some(m => m.id === 'auto'));
  } finally {
    await server.stop();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('server: GET /api/models returns 502 when Cursor CLI fails', async () => {
  const testRoot = path.join('/home/user/code', 'test-models-fail-' + Date.now());
  await fs.mkdir(testRoot, { recursive: true });

  const server = new AgentServer({
    rootDir: testRoot,
    port: 4897,
    host: '127.0.0.1',
    agentCmd: 'non-existent-agent-cmd-xyz'
  });

  try {
    await server.start();

    const res = await fetch('http://127.0.0.1:4897/api/models');
    assert.equal(res.status, 502);

    const data = await res.json();
    assert.ok(data.error);
    assert.match(data.error, /Failed to retrieve models from Cursor CLI/);
  } finally {
    await server.stop();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

