#!/usr/bin/env node

/**
 * Cursor Deck Mobile Web Control Panel CLI
 */

import path from 'node:path';
import fs from 'node:fs';
import QRCode from 'qrcode';
import { AgentServer } from '../src/server.js';

function parseArgs(args) {
  const options = {
    port: process.env.PORT || 4040,
    host: process.env.HOST || '0.0.0.0',
    rootDir: process.env.PROJECTS_ROOT || null,
    tailscaleOnly: process.env.TAILSCALE_ONLY === 'true' || process.env.TAILSCALE_ONLY === '1',
    authToken: process.env.AUTH_TOKEN || null,
    agentCmd: process.env.CURSOR_AGENT_CMD || 'agent'
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '-p') {
      options.port = parseInt(args[++i], 10);
    } else if (arg === '--host' || arg === '-h') {
      options.host = args[++i];
    } else if (arg === '--root' || arg === '-r') {
      options.rootDir = args[++i];
    } else if (arg === '--tailscale-only') {
      options.tailscaleOnly = true;
    } else if (arg === '--token' || arg === '-t') {
      options.authToken = args[++i];
    } else if (arg === '--agent-cmd') {
      options.agentCmd = args[++i];
    } else if (arg === '--help') {
      console.log(`
Usage: cursor-deck [options]

Self-hosted mobile-first control deck for driving the Cursor CLI across projects.

Options:
  -p, --port <number>      HTTP port to listen on (default: 4040, env: PORT)
  -h, --host <ip>          Host address to bind (default: 0.0.0.0, env: HOST)
  -r, --root <path>        Root directory containing projects (default: ~/code, env: PROJECTS_ROOT)
  --tailscale-only         Restrict access exclusively to Tailscale IPs (100.64.0.0/10)
  -t, --token <secret>     Require authentication token/PIN for remote access
  --agent-cmd <command>    Custom Cursor CLI executable (default: agent)
  --help                   Show this help message
`);
      process.exit(0);
    }
  }

  // Smart default for rootDir: prefer /home/user/code, or parent of current directory
  if (!options.rootDir) {
    const standardCodeDir = path.resolve(process.env.HOME || '/home/user', 'code');
    if (fs.existsSync(standardCodeDir)) {
      options.rootDir = standardCodeDir;
    } else {
      options.rootDir = path.resolve(process.cwd(), '..');
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = new AgentServer(options);

  try {
    const info = await server.start();
    const net = info.networkInfo;

    // Pick best URL for phone
    let phoneUrl = null;
    if (net.tailscaleIpv4) {
      phoneUrl = `http://${net.tailscaleIpv4}:${info.port}`;
    } else if (net.lanIpv4) {
      phoneUrl = `http://${net.lanIpv4}:${info.port}`;
    } else {
      phoneUrl = `http://localhost:${info.port}`;
    }

    if (options.authToken) {
      phoneUrl += `?token=${encodeURIComponent(options.authToken)}`;
    }

    const localUrl = `http://localhost:${info.port}${options.authToken ? `?token=${encodeURIComponent(options.authToken)}` : ''}`;

    console.clear?.();
    console.log(`\x1b[1;35m
╭───────────────────────────────────────────────────────────────╮
│                  ⚡ CURSOR DECK CONTROL PANEL                 │
╰───────────────────────────────────────────────────────────────╯\x1b[0m`);

    console.log(`\x1b[1mShared Root Directory:\x1b[0m \x1b[36m${info.rootDir}\x1b[0m`);
    console.log(`\x1b[1mHeadless CLI Command: \x1b[0m \x1b[33m${options.agentCmd} -p --force --trust\x1b[0m`);

    if (info.tailscaleOnly) {
      console.log(`\x1b[1;32mSecurity Policy:      \x1b[0m \x1b[32mTailscale Network Exclusively (100.64.0.0/10)\x1b[0m`);
    } else {
      console.log(`\x1b[1mNetwork Binding:      \x1b[0m ${info.host}:${info.port}`);
    }

    if (options.authToken) {
      console.log(`\x1b[1;33mAuth Protection:      \x1b[0m Enabled (Token configured)`);
    }

    console.log(`\n\x1b[1mLocal URL (Laptop):\x1b[0m   \x1b[4;34m${localUrl}\x1b[0m`);

    if (net.tailscaleIpv4) {
      console.log(`\x1b[1;32mTailscale URL (Phone):\x1b[0m \x1b[1;4;36mhttp://${net.tailscaleIpv4}:${info.port}${options.authToken ? `?token=${encodeURIComponent(options.authToken)}` : ''}\x1b[0m`);
    } else {
      console.log(`\x1b[33mTailscale Interface:   Not detected. Using LAN / Loopback.\x1b[0m`);
      if (net.lanIpv4) {
        console.log(`\x1b[1mLocal LAN URL:        \x1b[0m \x1b[4;34mhttp://${net.lanIpv4}:${info.port}${options.authToken ? `?token=${encodeURIComponent(options.authToken)}` : ''}\x1b[0m`);
      }
    }

    console.log(`\n\x1b[1mScan with Android camera to open instantly:\x1b[0m\n`);

    try {
      const qrAscii = await QRCode.toString(phoneUrl, { type: 'terminal', small: true });
      console.log(qrAscii);
    } catch {
      // ignore qr rendering errors
    }

    console.log(`\x1b[90mPress Ctrl+C to stop the server.\x1b[0m\n`);

    const shutdown = async () => {
      console.log('\n\x1b[33mShutting down Cursor Deck...\x1b[0m');
      await server.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (err) {
    console.error(`\x1b[1;31mFailed to start server:\x1b[0m`, err);
    process.exit(1);
  }
}

main();
