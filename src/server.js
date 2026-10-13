/**
 * Lightweight HTTP Server with SSE streaming and REST API.
 * Scoped to shared projects root, with Tailscale network access filtering.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

import { ProjectManager } from './project-manager.js';
import { ProcessManager } from './process-manager.js';
import { GitManager } from './git-manager.js';
import { SseHub } from './sse-hub.js';
import {
  getNetworkDetails,
  getClientIp,
  isTailscaleIp,
  isLocalhost
} from './tailscale.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

export class AgentServer {
  constructor(config = {}) {
    this.rootDir = config.rootDir || process.env.PROJECTS_ROOT || path.resolve(process.cwd(), '..');
    this.port = parseInt(config.port || process.env.PORT || '4040', 10);
    this.host = config.host || process.env.HOST || '0.0.0.0';
    this.tailscaleOnly = Boolean(config.tailscaleOnly || process.env.TAILSCALE_ONLY === 'true' || process.env.TAILSCALE_ONLY === '1');
    this.authToken = config.authToken || process.env.AUTH_TOKEN || null;
    this.agentCmd = config.agentCmd || process.env.CURSOR_AGENT_CMD || 'agent';

    this.projectManager = new ProjectManager(this.rootDir);
    this.sseHub = new SseHub({ bufferCapacity: 5000 });
    this.processManager = new ProcessManager({
      projectManager: this.projectManager,
      sseHub: this.sseHub,
      agentCmd: this.agentCmd
    });
    this.gitManager = new GitManager({
      projectManager: this.projectManager,
      sseHub: this.sseHub
    });

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.networkInfo = null;
  }

  async start() {
    this.networkInfo = await getNetworkDetails();

    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => {
        resolve({
          port: this.port,
          host: this.host,
          rootDir: this.projectManager.getRootDir(),
          networkInfo: this.networkInfo,
          tailscaleOnly: this.tailscaleOnly,
          hasAuthToken: Boolean(this.authToken)
        });
      });
    });
  }

  async stop() {
    this.sseHub.destroy();
    return new Promise(resolve => this.server.close(resolve));
  }

  /**
   * Main HTTP request router
   */
  async handleRequest(req, res) {
    const clientIp = getClientIp(req);
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Security Check: Tailscale Network Restriction
    if (this.tailscaleOnly) {
      const allowed = isTailscaleIp(clientIp) || isLocalhost(clientIp);
      if (!allowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Forbidden',
          message: `Access is restricted to the private Tailscale network (100.64.0.0/10). Client IP: ${clientIp}`,
          clientIp
        }));
        return;
      }
    }

    // Security Check: Authentication Token (if configured)
    if (this.authToken) {
      const authHeader = req.headers['authorization'];
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
      const queryToken = parsedUrl.searchParams.get('token');
      const providedToken = bearerToken || queryToken;

      // Allow static assets, but require token for API except health ping
      if (pathname.startsWith('/api/') && pathname !== '/api/health') {
        if (providedToken !== this.authToken) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Unauthorized',
            message: 'Invalid or missing authentication token'
          }));
          return;
        }
      }
    }

    // API Routes
    if (pathname.startsWith('/api/')) {
      return this.handleApiRequest(req, res, parsedUrl, clientIp);
    }

    // Static Asset Delivery
    return this.serveStatic(req, res, pathname);
  }

  /**
   * API Route Dispatcher
   */
  async handleApiRequest(req, res, parsedUrl, clientIp) {
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    // CORS headers for local/phone access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Last-Event-ID');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // 1. SSE Stream: /api/stream
      if (pathname === '/api/stream' && method === 'GET') {
        const project = parsedUrl.searchParams.get('project');
        const lastEventId = req.headers['last-event-id'] || parsedUrl.searchParams.get('lastEventId');
        return this.sseHub.handleConnection(req, res, project, lastEventId);
      }

      // 2. Health & Network info: /api/network
      if (pathname === '/api/network' && method === 'GET') {
        const currentNetwork = await getNetworkDetails();
        return this.sendJson(res, 200, {
          clientIp,
          isTailscaleClient: isTailscaleIp(clientIp),
          isLocalhostClient: isLocalhost(clientIp),
          tailscaleOnly: this.tailscaleOnly,
          network: currentNetwork,
          port: this.port,
          rootDir: this.projectManager.getRootDir(),
          agentCmd: this.agentCmd,
          isBusy: this.processManager.isBusy(),
          activeTask: this.processManager.getActiveTaskInfo()
        });
      }

      // 3. QR Code generation: /api/qr
      if (pathname === '/api/qr' && method === 'GET') {
        const targetUrl = parsedUrl.searchParams.get('url') ||
          (this.networkInfo?.tailscaleIpv4 ? `http://${this.networkInfo.tailscaleIpv4}:${this.port}` : `http://localhost:${this.port}`);

        const urlWithToken = this.authToken
          ? `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.authToken)}`
          : targetUrl;

        const dataUrl = await QRCode.toDataURL(urlWithToken, {
          margin: 2,
          width: 320,
          color: { dark: '#0a0d14', light: '#ffffff' }
        });

        return this.sendJson(res, 200, { dataUrl, url: urlWithToken });
      }

      // 4. Projects list: /api/projects
      if (pathname === '/api/projects' && method === 'GET') {
        const projects = await this.projectManager.listProjects();
        return this.sendJson(res, 200, {
          rootDir: this.projectManager.getRootDir(),
          count: projects.length,
          projects
        });
      }

      // 4b. Create project / repo: /api/projects (POST)
      if (pathname === '/api/projects' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const { name, initGit, cloneUrl, description, defaultBranch, initialCommit } = body;

        if (!name && !cloneUrl) {
          return this.sendJson(res, 400, { error: 'Project name or cloneUrl is required' });
        }

        let targetName = name;
        if (!targetName && cloneUrl) {
          const cleanUrl = cloneUrl.trim().replace(/\/+$/, '');
          const match = cleanUrl.match(/\/([^\/]+?)(\.git)?$/);
          if (match && match[1]) {
            targetName = match[1];
          }
        }

        if (!targetName) {
          return this.sendJson(res, 400, { error: 'Could not determine project name' });
        }

        const project = await this.projectManager.createProject({
          name: targetName,
          initGit: initGit !== false,
          cloneUrl: cloneUrl || null,
          description: description || '',
          defaultBranch: defaultBranch || 'main',
          initialCommit: initialCommit !== false
        });

        return this.sendJson(res, 201, {
          success: true,
          message: `Project ${project.name} created successfully`,
          project
        });
      }

      // 5. Single project details: /api/projects/:name
      if (pathname.startsWith('/api/projects/') && method === 'GET') {
        const projectName = decodeURIComponent(pathname.substring('/api/projects/'.length));
        const project = await this.projectManager.getProject(projectName);
        const session = this.processManager.getSession(projectName);
        return this.sendJson(res, 200, { project, session });
      }

      // 6. Process Execution: /api/run
      if (pathname === '/api/run' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const { project, prompt, continueSession, mode, model } = body;

        if (!project) {
          return this.sendJson(res, 400, { error: 'Project name is required' });
        }
        if (!prompt || !prompt.trim()) {
          return this.sendJson(res, 400, { error: 'Prompt is required' });
        }

        // Run asynchronously, respond immediately with accepted status
        // so client receives 202 and tracks progress via SSE stream
        const runPromise = this.processManager.runTask({
          projectName: project,
          prompt,
          continueSession: Boolean(continueSession),
          mode,
          model
        });

        // Don't await full completion to prevent HTTP timeouts on long agent runs
        // Errors will be broadcast via SSE and session status
        runPromise.catch(err => {
          console.error(`Task in ${project} encountered error:`, err.message);
        });

        return this.sendJson(res, 202, {
          accepted: true,
          project,
          continueSession: Boolean(continueSession),
          task: this.processManager.getActiveTaskInfo()
        });
      }

      // 7. Abort Execution: /api/abort
      if (pathname === '/api/abort' && method === 'POST') {
        const result = await this.processManager.abortActiveTask();
        return this.sendJson(res, 200, result);
      }

      // 8. Active Status: /api/status
      if (pathname === '/api/status' && method === 'GET') {
        return this.sendJson(res, 200, {
          isBusy: this.processManager.isBusy(),
          activeTask: this.processManager.getActiveTaskInfo()
        });
      }

      // 9. Session Stats: /api/session
      if (pathname === '/api/session' && method === 'GET') {
        const project = parsedUrl.searchParams.get('project');
        if (!project) return this.sendJson(res, 400, { error: 'Project parameter required' });
        return this.sendJson(res, 200, this.processManager.getSession(project));
      }

      // 10. Session Reset: /api/session/reset
      if (pathname === '/api/session/reset' && method === 'POST') {
        const body = await this.readJsonBody(req);
        if (!body.project) return this.sendJson(res, 400, { error: 'Project parameter required' });
        const result = this.processManager.resetSession(body.project);
        return this.sendJson(res, 200, result);
      }

      // 11. Log history: /api/logs
      if (pathname === '/api/logs' && method === 'GET') {
        const project = parsedUrl.searchParams.get('project');
        const limit = parseInt(parsedUrl.searchParams.get('limit') || '500', 10);
        const logs = this.sseHub.getProjectLogs(project, limit);
        return this.sendJson(res, 200, { logs });
      }

      // 12. Clear logs: /api/logs
      if (pathname === '/api/logs' && method === 'DELETE') {
        const project = parsedUrl.searchParams.get('project');
        this.sseHub.clearProjectLogs(project);
        return this.sendJson(res, 200, { success: true });
      }

      // 13. Git Status: /api/git/status
      if (pathname === '/api/git/status' && method === 'GET') {
        const project = parsedUrl.searchParams.get('project');
        if (!project) return this.sendJson(res, 400, { error: 'Project parameter required' });
        const status = await this.gitManager.getStatus(project);
        return this.sendJson(res, 200, status);
      }

      // 14. Git Diff: /api/git/diff
      if (pathname === '/api/git/diff' && method === 'GET') {
        const project = parsedUrl.searchParams.get('project');
        const target = parsedUrl.searchParams.get('target') || 'all'; // 'all', 'staged', 'unstaged'
        const filePath = parsedUrl.searchParams.get('file') || null;
        if (!project) return this.sendJson(res, 400, { error: 'Project parameter required' });
        const diff = await this.gitManager.getDiff(project, { target, filePath });
        return this.sendJson(res, 200, diff);
      }

      // 15. Emergency Discard: /api/git/discard
      if (pathname === '/api/git/discard' && method === 'POST') {
        const body = await this.readJsonBody(req);
        if (!body.project) return this.sendJson(res, 400, { error: 'Project parameter required' });
        const status = await this.gitManager.emergencyDiscard(body.project);
        return this.sendJson(res, 200, { success: true, status });
      }

      // 16. Local Commit: /api/git/commit
      if (pathname === '/api/git/commit' && method === 'POST') {
        const body = await this.readJsonBody(req);
        if (!body.project) return this.sendJson(res, 400, { error: 'Project parameter required' });
        if (!body.message) return this.sendJson(res, 400, { error: 'Commit message is required' });
        const result = await this.gitManager.commitChanges(body.project, body.message, body.stageAll !== false);
        return this.sendJson(res, 200, result);
      }

      // 17. Git Stage: /api/git/stage
      if (pathname === '/api/git/stage' && method === 'POST') {
        const body = await this.readJsonBody(req);
        if (!body.project) return this.sendJson(res, 400, { error: 'Project parameter required' });
        const status = await this.gitManager.stageFiles(body.project, body.files || []);
        return this.sendJson(res, 200, { success: true, status });
      }

      // 18. Git Unstage: /api/git/unstage
      if (pathname === '/api/git/unstage' && method === 'POST') {
        const body = await this.readJsonBody(req);
        if (!body.project) return this.sendJson(res, 400, { error: 'Project parameter required' });
        const status = await this.gitManager.unstageFiles(body.project, body.files || []);
        return this.sendJson(res, 200, { success: true, status });
      }

      // 404 for unknown API
      return this.sendJson(res, 404, { error: 'Not found', path: pathname });
    } catch (err) {
      const statusCode = err.status || 500;
      if (statusCode >= 500) {
        console.error(`API Error [${pathname}]:`, err);
      }
      return this.sendJson(res, statusCode, {
        error: err.name || 'Error',
        message: err.message,
        activeTask: err.activeTask || null
      });
    }
  }

  /**
   * Serve static frontend files
   */
  async serveStatic(req, res, pathname) {
    let filePath = pathname === '/' ? '/index.html' : pathname;
    const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(PUBLIC_DIR, safePath);

    // Ensure requested file stays inside PUBLIC_DIR
    if (!fullPath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!existsSync(fullPath)) {
      // Fallback to index.html for SPA routing
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      if (existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        createReadStream(indexPath).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      const subIndexPath = path.join(fullPath, 'index.html');
      if (existsSync(subIndexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        createReadStream(subIndexPath).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });

    createReadStream(fullPath).pipe(res);
  }

  /**
   * Helper to send JSON responses
   */
  sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  /**
   * Helper to parse JSON request bodies
   */
  readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => {
        data += chunk;
        if (data.length > 5 * 1024 * 1024) {
          // 5MB limit
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid JSON format'));
        }
      });
      req.on('error', reject);
    });
  }
}
