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
  const validPath = pm.resolveSafeProjectPath('cursor-agent');
  assert.equal(validPath, '/home/user/code/cursor-agent');

  // Traversal attempts must throw security violation
  assert.throws(() => pm.resolveSafeProjectPath('../'), /Invalid project name|traversal attempt/);
  assert.throws(() => pm.resolveSafeProjectPath('../../etc/passwd'), /Invalid project name|traversal attempt/);
  assert.throws(() => pm.resolveSafeProjectPath('cursor-agent/../../etc'), /Invalid project name|traversal attempt/);
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
    assert.ok(htmlText.includes('Cursor Agent'));

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
    const hasCurrent = projData.projects.some(p => p.name === 'cursor-agent');
    assert.equal(hasCurrent, true);

    // 4. Git status API
    const gitRes = await fetch('http://127.0.0.1:4899/api/git/status?project=cursor-agent');
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
    projectName: 'cursor-agent',
    prompt: 'long running task',
    startTime: Date.now(),
    isFinished: false
  };

  assert.equal(procMgr.isBusy(), true);

  // Trying to run another task while busy must throw 409
  await assert.rejects(
    async () => {
      await procMgr.runTask({
        projectName: 'cursor-agent',
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
  assert.equal(abortRes.projectName, 'cursor-agent');

  procMgr.activeTask = null;
  assert.equal(procMgr.isBusy(), false);
});
