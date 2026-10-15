'use strict';

/**
 * WLED UDP realtime sender (DRGB / DNRGB).
 *
 * WLED takes raw pixel frames on its notifier port (default 21324). A frame
 * puts WLED in realtime mode for `timeout` seconds; a frame with timeout 0
 * ends realtime mode at once and WLED shows its normal (HTTP) state again.
 * One UDP packet per frame is much faster than one HTTP request per frame.
 *
 * Bytes are always sent as R, G, B. WLED applies the strip's colour order,
 * the global brightness and (if enabled there) gamma itself.
 *
 * Protocol: https://kno.wled.ge/interfaces/udp-realtime/
 *
 * SECURITY: the IP is validated with assertValidIp() and the port is
 * range-checked before any packet is sent. UDP is unencrypted, same trust
 * model as the HTTP API: trusted LAN only.
 */

const dgram = require('dgram');
const { assertValidIp } = require('./wled-api');

const DEFAULT_PORT = 21324;
const DRGB         = 2;    // [2, timeout, R,G,B ...]               max 490 LEDs
const DNRGB        = 4;    // [4, timeout, startHi, startLo, R,G,B ...] max 489 LEDs per packet
const DRGB_MAX     = 490;
const DNRGB_MAX    = 489;
const LIVE_TIMEOUT_S = 2;

function validPort(port) {
  const p = Number(port);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
}

/**
 * Build the packets for one frame.
 * @param {Array<number[]>} pixels - [R,G,B] per LED
 * @param {number} timeout - seconds WLED stays in realtime mode
 * @returns {Buffer[]}
 */
function buildPackets(pixels, timeout) {
  const put = (buf, offset, px) => {
    buf[offset]     = px[0] & 0xFF;
    buf[offset + 1] = px[1] & 0xFF;
    buf[offset + 2] = px[2] & 0xFF;
  };

  if (pixels.length <= DRGB_MAX) {
    const buf = Buffer.alloc(2 + pixels.length * 3);
    buf[0] = DRGB;
    buf[1] = timeout;
    pixels.forEach((px, i) => put(buf, 2 + i * 3, px));
    return [buf];
  }

  const packets = [];
  for (let start = 0; start < pixels.length; start += DNRGB_MAX) {
    const chunk = pixels.slice(start, start + DNRGB_MAX);
    const buf = Buffer.alloc(4 + chunk.length * 3);
    buf[0] = DNRGB;
    buf[1] = timeout;
    buf[2] = (start >> 8) & 0xFF;
    buf[3] = start & 0xFF;
    chunk.forEach((px, i) => put(buf, 4 + i * 3, px));
    packets.push(buf);
  }
  return packets;
}

/**
 * Apply WLED's colour gamma to an [R,G,B] colour (same formula as WLED's
 * calcGammaTable: round((v/255)^gamma * 255)). gamma 1 = unchanged.
 */
function gammaCorrect(rgb, gamma) {
  if (!(gamma > 1)) return rgb;
  return rgb.map(v => Math.round(Math.pow(Math.max(0, Math.min(255, v)) / 255, gamma) * 255));
}

class WledUdpSender {

  constructor() {
    this._socket = null;
  }

  open() {
    if (this._socket) return;
    this._socket = dgram.createSocket('udp4');
    this._socket.on('error', () => {});
  }

  /** Send one frame; WLED stays in realtime mode for LIVE_TIMEOUT_S. */
  async sendFrame(ip, port, pixels) {
    for (const buf of buildPackets(pixels, LIVE_TIMEOUT_S)) {
      await this._send(ip, port, buf);
    }
  }

  /** End realtime mode now; WLED shows its HTTP state on its next loop. */
  async exitRealtime(ip, port) {
    await this._send(ip, port, Buffer.from([DRGB, 0]));
  }

  _send(ip, port, buf) {
    assertValidIp(ip);
    if (!this._socket) return Promise.reject(new Error('UDP socket not open'));
    return new Promise((resolve, reject) => {
      this._socket.send(buf, 0, buf.length, validPort(port), ip, err => (err ? reject(err) : resolve()));
    });
  }

  close() {
    if (this._socket) {
      try { this._socket.close(); } catch (_) { /* already closed */ }
      this._socket = null;
    }
  }

}

module.exports = { WledUdpSender, DEFAULT_PORT, validPort, gammaCorrect };
