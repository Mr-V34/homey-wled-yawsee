'use strict';

/**
 * WLED HTTP API wrapper.
 *
 * SECURITY NOTE: WLED uses plain HTTP (no TLS). This is acceptable for a
 * trusted home LAN but means traffic is unencrypted on the local network.
 * Never expose the WLED device directly to the internet.
 */

const FETCH_TIMEOUT_MS = 5000;

// Validates IPv4 format and blocks reserved/SSRF-risky ranges.
function assertValidIp(ip) {
  if (typeof ip !== 'string' || !/^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/.test(ip)) {
    throw new Error(`Invalid IP address: "${ip}"`);
  }
  const [a, b] = ip.split('.').map(Number);
  // M-06: block loopback, unspecified, link-local, multicast, and reserved ranges
  if (
    a === 0                    ||  // 0.0.0.0/8     unspecified
    a === 127                  ||  // 127.0.0.0/8   loopback
    (a === 169 && b === 254)   ||  // 169.254.0.0/16 link-local
    a >= 224                       // 224.0.0.0/4+   multicast & reserved
  ) {
    throw new Error(`Blocked reserved IP address: "${ip}"`);
  }
}

async function _fetch(ip, path, options = {}) {
  assertValidIp(ip);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`http://${ip}${path}`, {
      ...options,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`WLED returned HTTP ${res.status} for ${path}`);
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timeout connecting to ${ip}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getInfo(ip) {
  const res = await _fetch(ip, '/json/info');
  return res.json();
}

async function getState(ip) {
  const res = await _fetch(ip, '/json/state');
  return res.json();
}

async function setState(ip, payload) {
  const res = await _fetch(ip, '/json/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

module.exports = { getInfo, getState, setState, assertValidIp };
