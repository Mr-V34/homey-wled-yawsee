'use strict';

const Homey = require('homey');
const { getInfo } = require('../../lib/wled-api');

class WledStripDriver extends Homey.Driver {

  async onInit() {
    this.log('WledStripDriver initialized');

    // ── Flow: Slide ON ────────────────────────────────────────────────────
    this.homey.flow.getActionCard('slide_on')
      .registerRunListener(async ({ device }) => {
        this.log(`[flow] slide_on → ${device.getName()}`);
        await device.slideOn();
      });

    // ── Flow: Slide OFF ───────────────────────────────────────────────────
    this.homey.flow.getActionCard('slide_off')
      .registerRunListener(async ({ device }) => {
        this.log(`[flow] slide_off → ${device.getName()}`);
        await device.slideOff();
      });

    // ── Flow: Set slide speed ─────────────────────────────────────────────
    this.homey.flow.getActionCard('set_slide_speed')
      .registerRunListener(async ({ device, speed }) => {
        const n = Number(speed);
        if (!Number.isFinite(n)) throw new Error(`Invalid speed value: ${speed}`);
        const clamped = Math.max(10, Math.min(500, Math.round(n)));
        this.log(`[flow] set_slide_speed → ${device.getName()} = ${clamped} ms`);
        await device.setSettings({ slide_speed_ms: clamped });
      });
  }

  // ── Pairing ─────────────────────────────────────────────────────────────
  // Custom pair views: list_devices.html and manual_entry.html

  async onPair(session) {
    // 'get_devices' — invoked by list_devices.html via Homey.emit('get_devices')
    // Note: 'list_devices' is a reserved Homey event name; must use a custom name
    session.setHandler('get_devices', async () => {
      const strategy = this.getDiscoveryStrategy();
      const results  = Object.values(strategy.getDiscoveryResults());
      this.log(`mDNS scan: ${results.length} device(s) found`);
      const devices = await Promise.all(
        results.map(result => this._buildDeviceFromDiscovery(result))
      );
      return devices.filter(Boolean);
    });

    // 'manual_pair' — invoked by manual_entry.html via Homey.emit('manual_pair', { ip })
    session.setHandler('manual_pair', async ({ ip }) => {
      this.log(`[pair] manual_pair: ${ip}`);
      return this._buildDeviceFromIp(ip);
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  async _buildDeviceFromDiscovery(result) {
    try {
      const ip   = result.address;
      const info = await getInfo(ip);
      return this._deviceObject(ip, info);
    } catch (err) {
      this.error(`Failed to query mDNS device at ${result.address}:`, err.message);
      return null;
    }
  }

  async _buildDeviceFromIp(ip) {
    // getInfo will validate the IP and throw on bad format / timeout
    const info = await getInfo(ip);
    return this._deviceObject(ip, info);
  }

  _deviceObject(ip, info) {
    // Sanitise the device name — never trust external input for display
    const rawName  = String(info.name ?? 'WLED').slice(0, 64);
    const safeName = rawName.replace(/[<>&"']/g, '');

    return {
      name: safeName || 'WLED Strip',
      data: {
        // MAC is stable across reboots and IP changes — use as unique ID
        id: String(info.mac ?? ip).toLowerCase().slice(0, 64),
      },
      store: {
        address: ip,
      },
      settings: {
        num_leds:     Math.max(1, Math.min(1024, Number(info.leds?.count) || 20)),
        slide_speed_ms: 50,
        transition_ms:  0,
        firmware:      String(info.ver ?? 'unknown').slice(0, 32).replace(/[<>&"']/g, ''),
        ip_address:    ip,
      },
    };
  }

}

module.exports = WledStripDriver;
