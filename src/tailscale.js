/**
 * Tailscale network discovery and access control utilities.
 */

import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Checks if an IPv4 address falls within the Tailscale CGNAT subnet (100.64.0.0/10)
 * Range: 100.64.0.0 - 100.127.255.255
 */
export function isTailscaleIpv4(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const cleanIp = ip.replace(/^::ffff:/, '');
  const parts = cleanIp.split('.').map(p => parseInt(p, 10));
  if (parts.length !== 4 || parts.some(isNaN)) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/**
 * Checks if an IPv6 address falls within Tailscale CGNAT range (fd7a:115c:a1e0::/48)
 */
export function isTailscaleIpv6(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const cleanIp = ip.toLowerCase();
  return cleanIp.startsWith('fd7a:115c:a1e0:');
}

/**
 * Checks if an IP is a Tailscale address (IPv4 or IPv6)
 */
export function isTailscaleIp(ip) {
  return isTailscaleIpv4(ip) || isTailscaleIpv6(ip);
}

/**
 * Checks if an IP is localhost
 */
export function isLocalhost(ip) {
  if (!ip) return false;
  const cleanIp = ip.replace(/^::ffff:/, '');
  return cleanIp === '127.0.0.1' || cleanIp === '::1' || cleanIp === 'localhost';
}

/**
 * Discover network interfaces and identify Tailscale and local IPs
 */
export async function getNetworkDetails() {
  const interfaces = os.networkInterfaces();
  let tailscaleIpv4 = null;
  let tailscaleIpv6 = null;
  let lanIpv4 = null;
  const allIps = [];

  for (const [name, netList] of Object.entries(interfaces)) {
    if (!netList) continue;
    const isTailscaleInterface = name.toLowerCase().includes('tailscale') || name.toLowerCase().startsWith('ts');

    for (const net of netList) {
      if (net.internal) continue;

      if (net.family === 'IPv4') {
        allIps.push({ interface: name, address: net.address, family: 'IPv4' });
        if (isTailscaleIpv4(net.address) || isTailscaleInterface) {
          tailscaleIpv4 = net.address;
        } else if (!lanIpv4 && (net.address.startsWith('192.168.') || net.address.startsWith('10.') || net.address.startsWith('172.'))) {
          lanIpv4 = net.address;
        }
      } else if (net.family === 'IPv6') {
        if (isTailscaleIpv6(net.address) || (isTailscaleInterface && !net.address.startsWith('fe80:'))) {
          tailscaleIpv6 = net.address;
        }
      }
    }
  }

  // If not found in network interfaces directly, attempt to query the tailscale CLI
  if (!tailscaleIpv4) {
    try {
      const { stdout } = await execAsync('tailscale ip -4', { timeout: 1500 });
      const ip = stdout.trim();
      if (ip && isTailscaleIpv4(ip)) {
        tailscaleIpv4 = ip;
      }
    } catch {
      // tailscale CLI not available or not logged in
    }
  }

  return {
    tailscaleIpv4,
    tailscaleIpv6,
    lanIpv4,
    allIps,
    hasTailscale: Boolean(tailscaleIpv4 || tailscaleIpv6)
  };
}

/**
 * Normalize client IP from HTTP request
 */
export function getClientIp(req) {
  // Check X-Forwarded-For if behind reverse proxy
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const parts = forwarded.split(',');
    return parts[0].trim().replace(/^::ffff:/, '');
  }
  const socketIp = req.socket?.remoteAddress || '';
  return socketIp.replace(/^::ffff:/, '');
}
