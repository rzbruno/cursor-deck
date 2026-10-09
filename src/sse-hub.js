/**
 * Resilient Server-Sent Events (SSE) broker with ring-buffer replay.
 * Designed specifically for mobile network conditions, phone sleep/wake cycles,
 * and Tailscale network handoffs without dropping logs.
 */

import { ansiToHtml, stripAnsi } from './ansi-parser.js';

export class SseHub {
  constructor(options = {}) {
    this.bufferCapacity = options.bufferCapacity || 5000;
    this.clients = new Set();
    this.ringBuffer = [];
    this.nextEventId = 1;

    // Send keepalive comment every 15s to keep mobile connection alive
    this.keepAliveInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 15000);
    this.keepAliveInterval.unref?.();
  }

  /**
   * Handle incoming SSE connection from client
   */
  handleConnection(req, res, targetProject, lastEventId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no'
    });

    // Flush headers immediately
    if (res.flushHeaders) res.flushHeaders();

    const client = {
      id: Math.random().toString(36).substring(2),
      project: targetProject || null,
      res,
      req,
      connectedAt: Date.now()
    };

    this.clients.add(client);

    // Initial handshake
    this.sendToClient(client, {
      type: 'handshake',
      clientCount: this.clients.size,
      currentEventId: this.nextEventId - 1,
      targetProject: client.project,
      timestamp: Date.now()
    });

    // If client provided Last-Event-ID or lastEventId param, replay missed events
    if (lastEventId !== undefined && lastEventId !== null && !isNaN(lastEventId)) {
      const fromId = parseInt(lastEventId, 10);
      const missedEvents = this.ringBuffer.filter(
        ev => ev.id > fromId && (!client.project || ev.project === client.project)
      );

      for (const ev of missedEvents) {
        this.sendToClient(client, ev);
      }
    }

    req.on('close', () => {
      this.clients.delete(client);
    });

    req.on('error', () => {
      this.clients.delete(client);
    });
  }

  /**
   * Send heartbeat comment to all active clients
   */
  sendHeartbeat() {
    for (const client of this.clients) {
      try {
        client.res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /**
   * Send single event to a single client
   */
  sendToClient(client, data) {
    try {
      const idStr = data.id ? `id: ${data.id}\n` : '';
      const eventType = data.type || 'message';
      client.res.write(`${idStr}event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.clients.delete(client);
    }
  }

  /**
   * Emit and buffer a new log message
   */
  publishLog(project, text, streamType = 'stdout') {
    if (text === undefined || text === null) return;
    const str = String(text);
    if (!str) return;

    const event = {
      id: this.nextEventId++,
      type: 'log',
      project,
      stream: streamType, // 'stdout', 'stderr', 'system'
      html: ansiToHtml(str),
      text: stripAnsi(str),
      raw: str,
      timestamp: Date.now()
    };

    // Add to ring buffer
    this.ringBuffer.push(event);
    if (this.ringBuffer.length > this.bufferCapacity) {
      this.ringBuffer.shift();
    }

    // Broadcast to clients listening to this project or listening to all
    for (const client of this.clients) {
      if (!client.project || client.project === project) {
        this.sendToClient(client, event);
      }
    }

    return event;
  }

  /**
   * Publish a status change event (e.g. idle, running, finished, error, aborted)
   */
  publishStatus(project, statusData) {
    const event = {
      id: this.nextEventId++,
      type: 'status',
      project,
      ...statusData,
      timestamp: Date.now()
    };

    this.ringBuffer.push(event);
    if (this.ringBuffer.length > this.bufferCapacity) {
      this.ringBuffer.shift();
    }

    for (const client of this.clients) {
      if (!client.project || client.project === project) {
        this.sendToClient(client, event);
      }
    }

    return event;
  }

  /**
   * Get log history for a specific project
   */
  getProjectLogs(project, limit = 1000) {
    return this.ringBuffer
      .filter(ev => ev.type === 'log' && (!project || ev.project === project))
      .slice(-limit);
  }

  /**
   * Clear logs in memory for a project
   */
  clearProjectLogs(project) {
    if (!project) {
      this.ringBuffer = [];
    } else {
      this.ringBuffer = this.ringBuffer.filter(ev => ev.project !== project);
    }

    const clearEvent = {
      id: this.nextEventId++,
      type: 'clear',
      project,
      timestamp: Date.now()
    };

    for (const client of this.clients) {
      if (!client.project || client.project === project) {
        this.sendToClient(client, clearEvent);
      }
    }
  }

  getClientCount() {
    return this.clients.size;
  }

  destroy() {
    clearInterval(this.keepAliveInterval);
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch {}
    }
    this.clients.clear();
  }
}
