'use strict';

const Homey   = require('homey');
const wled                  = require('../../lib/wled-api');
const { assertValidIp }     = require('../../lib/wled-api');
const { hsvToRgb, ctToRgb } = require('../../lib/color-utils');

// How often to poll WLED for current state (ms)
const POLL_INTERVAL_MS = 30_000;

// Worm-tail brightness as a fraction of the main color (0 = off, 1 = full)
const TAIL_BRIGHTNESS = 0.35;

class WledStripDevice extends Homey.Device {

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async onInit() {
    this.log(`Device init: "${this.getName()}" @ ${this.getStoreValue('address')}`);

    this._slideGen     = 0;      // M-04: increments on each new animation; cancels the previous
    this._animating    = false;  // true while any slide animation is running (suppresses poll)
    this._pollTimer    = null;

    // Flow trigger card handle
    this._slideDoneTrigger = this.homey.flow.getDeviceTriggerCard('slide_completed');

    // ── Capability listeners ────────────────────────────────────────────
    this.registerCapabilityListener('onoff', this._onOnOff.bind(this));
    this.registerCapabilityListener('dim',   this._onDim.bind(this));

    // Batch colour changes with 300 ms debounce to avoid flooding the API
    this.registerMultipleCapabilityListener(
      ['light_hue', 'light_saturation', 'light_temperature', 'light_mode'],
      this._onColor.bind(this),
      300,
    );

    // ── Settings ────────────────────────────────────────────────────────
    await this._applySettings();

    // ── Poll ────────────────────────────────────────────────────────────
    this._startPolling();

    await this.setAvailable();
    this.log('Device ready');
  }

  async onAdded() {
    this.log(`Device "${this.getName()}" added to Homey`);
  }

  async onDeleted() {
    this.log(`Device "${this.getName()}" removed`);
    this._stopPolling();
  }

  async onUninit() {
    this._stopPolling();
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys.join(', '));

    // SECURITY: clamp num_leds so a rogue value can't cause a runaway loop
    if (changedKeys.includes('num_leds')) {
      const clamped = Math.max(1, Math.min(1024, Math.round(newSettings.num_leds)));
      if (clamped !== newSettings.num_leds) {
        throw new Error(`num_leds must be between 1 and 1024 (got ${newSettings.num_leds})`);
      }
    }

    if (changedKeys.includes('slide_speed_ms')) {
      const v = newSettings.slide_speed_ms;
      if (v < 10 || v > 500) throw new Error('Slide speed must be 10–500 ms');
    }

    this.log('Settings validated and applied');
  }

  async onRenamed(name) {
    this.log(`Device renamed to "${name}"`);
  }

  // ── mDNS discovery callbacks ─────────────────────────────────────────────

  onDiscoveryResult(result) {
    return result.id === this.getData().id;
  }

  async onDiscoveryAvailable(result) {
    try { assertValidIp(result.address); } catch (err) {
      this.error(`mDNS: ignoring invalid address "${result.address}": ${err.message}`);
      return;
    }
    this.log(`mDNS: device available at ${result.address}`);
    await this.setStoreValue('address', result.address);
    await this.setSettings({ ip_address: result.address });
    await this.setAvailable();
  }

  onDiscoveryAddressChanged(result) {
    try { assertValidIp(result.address); } catch (err) {
      this.error(`mDNS: ignoring invalid address change "${result.address}": ${err.message}`);
      return;
    }
    this.log(`mDNS: IP changed to ${result.address}`);
    this.setStoreValue('address', result.address).catch(this.error);
    this.setSettings({ ip_address: result.address }).catch(this.error);
  }

  onDiscoveryLastSeenChanged() {
    this.setAvailable().catch(this.error);
  }

  // ── Capability handlers ──────────────────────────────────────────────────

  async _onOnOff(value) {
    this.log(`onoff → ${value}`);
    if (value) {
      await this.slideOn();
    } else {
      await this.slideOff();
    }
  }

  async _onDim(value) {
    const bri = Math.round(value * 255);
    this.log(`dim → ${value} (bri ${bri})`);
    await this._wledPost({ bri, transition: 0 });
  }

  async _onColor({ light_hue, light_saturation, light_temperature, light_mode }) {
    const dim  = this.getCapabilityValue('dim') ?? 1;
    // Fall back to the current stored mode — light_mode is only present in the
    // callback when it actually changed; it's undefined when only hue/sat/ct changed.
    const mode = light_mode ?? this.getCapabilityValue('light_mode');
    const leds = Math.max(1, Math.min(1024, Math.round(this.getSetting('num_leds'))));

    let rgb;
    if (mode === 'temperature') {
      const ct = light_temperature ?? this.getCapabilityValue('light_temperature') ?? 0.5;
      rgb = ctToRgb(ct);
    } else {
      const h = light_hue        ?? this.getCapabilityValue('light_hue')        ?? 0;
      const s = light_saturation ?? this.getCapabilityValue('light_saturation') ?? 1;
      // V=1 always: pure hue at full value. WLED's global bri (set by _onDim)
      // controls actual brightness — same approach as ctToRgb.
      rgb = hsvToRgb(h, s, 1);
    }

    this.log(`color → RGB [${rgb}] mode=${mode}`);
    await this._wledPost({
      bri: Math.round(dim * 255),
      transition: 0,
      // Reset segment 0 boundaries and clear the worm-tail segment (id:1)
      // in case a cancelled animation left them in a non-default state.
      seg: [
        { id: 0, start: 0, stop: leds, col: [rgb, [0, 0, 0], [0, 0, 0]], fx: 0 },
        { id: 1, start: 0, stop: 0 },
      ],
    });
  }

  // ── Sliding effect (worm/snake) ───────────────────────────────────────────
  //
  // Two WLED segments are used simultaneously:
  //   Segment 0 — the bright body of the worm (full color)
  //   Segment 1 — a single dim LED at the leading/trailing edge (TAIL_BRIGHTNESS)
  //
  // Each step posts both segments atomically, so the tail always tracks the
  // edge of the body one LED ahead (slideOn) or one LED behind (slideOff).
  // No WLED transition timing tricks are needed — the effect is purely geometric.

  async slideOn() {
    const gen = ++this._slideGen;
    this._animating = true;
    const reverse = this.getSetting('reverse') || false;
    this.log(`slideOn: starting (${reverse ? 'reverse' : 'forward'})`);

    const { leds, speed, color } = this._effectParams();
    const tailColor = color.map(c => Math.round(c * TAIL_BRIGHTNESS));
    const bri = Math.round((this.getCapabilityValue('dim') ?? 1) * 255);

    try {
      if (!reverse) {
        // ── Forward: expand stop left → right ────────────────────────────
        await this._wledPost({
          on: true, bri, transition: 0,
          seg: [
            { id: 0, start: 0, stop: 1, col: [color, [0,0,0], [0,0,0]], fx: 0 },
            { id: 1, start: 0, stop: 0 },
          ],
        });
        for (let i = 2; i <= leds; i++) {
          if (this._slideGen !== gen) { this.log('slideOn: superseded'); return; }
          await this._wledPost({
            transition: 0,
            seg: [
              { id: 0, stop: i },
              { id: 1, start: i, stop: Math.min(leds, i + 1), col: [tailColor, [0,0,0], [0,0,0]], fx: 0 },
            ],
          });
          await this._sleep(speed);
        }
      } else {
        // ── Reverse: expand start right → left ───────────────────────────
        await this._wledPost({
          on: true, bri, transition: 0,
          seg: [
            { id: 0, start: leds - 1, stop: leds, col: [color, [0,0,0], [0,0,0]], fx: 0 },
            { id: 1, start: 0, stop: 0 },
          ],
        });
        for (let start = leds - 2; start >= 0; start--) {
          if (this._slideGen !== gen) { this.log('slideOn: superseded'); return; }
          const tStart = start - 1; const tStop = start;
          await this._wledPost({
            transition: 0,
            seg: [
              { id: 0, start },
              tStop > tStart
                ? { id: 1, start: tStart, stop: tStop, col: [tailColor, [0,0,0], [0,0,0]], fx: 0 }
                : { id: 1, start: 0, stop: 0 },
            ],
          });
          await this._sleep(speed);
        }
      }

      if (this._slideGen !== gen) return;
      await this._wledPost({ transition: 0, seg: [{ id: 1, start: 0, stop: 0 }] });
      await this.setCapabilityValue('onoff', true).catch(this.error);
      this.log('slideOn: complete');
      await this._slideDoneTrigger.trigger(this, { direction: 'on' }, {});

    } catch (err) {
      if (this._slideGen !== gen) return;
      this.error('slideOn failed:', err.message);
      await this.setUnavailable(err.message);
    } finally {
      if (this._slideGen === gen) this._animating = false;
    }
  }

  async slideOff() {
    const gen = ++this._slideGen;
    this._animating = true;
    const reverse = this.getSetting('reverse') || false;
    this.log(`slideOff: starting (${reverse ? 'reverse' : 'forward'})`);

    const { leds, speed, color } = this._effectParams();
    const tailColor = color.map(c => Math.round(c * TAIL_BRIGHTNESS));
    const bri = Math.round((this.getCapabilityValue('dim') ?? 1) * 255);

    try {
      // Both directions start from a full lit strip
      await this._wledPost({
        on: true, bri, transition: 0,
        seg: [
          { id: 0, start: 0, stop: leds, col: [color, [0,0,0], [0,0,0]], fx: 0 },
          { id: 1, start: 0, stop: 0 },
        ],
      });

      if (!reverse) {
        // ── Forward: shrink stop right → left ────────────────────────────
        for (let i = leds - 1; i >= 1; i--) {
          if (this._slideGen !== gen) { this.log('slideOff: superseded'); return; }
          await this._wledPost({
            transition: 0,
            seg: [
              { id: 0, stop: i },
              { id: 1, start: i, stop: i + 1, col: [tailColor, [0,0,0], [0,0,0]], fx: 0 },
            ],
          });
          await this._sleep(speed);
        }
      } else {
        // ── Reverse: grow start left → right ─────────────────────────────
        for (let start = 1; start < leds; start++) {
          if (this._slideGen !== gen) { this.log('slideOff: superseded'); return; }
          await this._wledPost({
            transition: 0,
            seg: [
              { id: 0, start },
              { id: 1, start: start - 1, stop: start, col: [tailColor, [0,0,0], [0,0,0]], fx: 0 },
            ],
          });
          await this._sleep(speed);
        }
      }

      if (this._slideGen !== gen) return;
      await this._wledPost({ on: false, seg: [{ id: 1, start: 0, stop: 0 }] });
      await this.setCapabilityValue('onoff', false).catch(this.error);
      this.log('slideOff: complete');
      await this._slideDoneTrigger.trigger(this, { direction: 'off' }, {});

    } catch (err) {
      if (this._slideGen !== gen) return;
      this.error('slideOff failed:', err.message);
      await this.setUnavailable(err.message);
    } finally {
      if (this._slideGen === gen) this._animating = false;
    }
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  _startPolling() {
    this._stopPolling();
    this._pollTimer = this.homey.setInterval(
      this._poll.bind(this),
      POLL_INTERVAL_MS,
    );
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _poll() {
    if (this._animating) return; // don't overwrite state mid-animation
    try {
      const ip    = this.getStoreValue('address');
      const state = await wled.getState(ip);

      await this.setCapabilityValue('onoff', Boolean(state.on));
      // SECURITY: clamp bri from untrusted WLED response to valid 0-255 range
      const bri = Math.max(0, Math.min(255, Number(state.bri) || 128));
      await this.setCapabilityValue('dim', bri / 255);
      await this.setAvailable();

    } catch (err) {
      this.error('Poll failed:', err.message);
      await this.setUnavailable(`Offline: ${err.message}`);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _effectParams() {
    const s          = this.getSettings();
    // SECURITY: fallback to safe defaults if settings are NaN/undefined
    const rawLeds    = Number(s.num_leds);
    const leds       = Number.isFinite(rawLeds) ? Math.max(1, Math.min(1024, Math.round(rawLeds))) : 20;
    const rawSpeed   = Number(s.slide_speed_ms);
    const speed      = Number.isFinite(rawSpeed) ? Math.max(10, Math.min(500, Math.round(rawSpeed))) : 50;

    // Resolve current color from capabilities
    const mode = this.getCapabilityValue('light_mode');
    let color;
    if (mode === 'temperature') {
      color = ctToRgb(this.getCapabilityValue('light_temperature') ?? 0.5);
    } else {
      color = hsvToRgb(
        this.getCapabilityValue('light_hue')        ?? 0,
        this.getCapabilityValue('light_saturation') ?? 1,
        1,  // V=1; WLED bri handles actual brightness
      );
    }

    return { leds, speed, color };
  }

  async _wledPost(payload) {
    const ip = this.getStoreValue('address');
    return wled.setState(ip, payload);
  }

  async _applySettings() {
    // Expose IP label on settings page (read-only cosmetic)
    const ip = this.getStoreValue('address');
    if (ip) await this.setSettings({ ip_address: ip }).catch(() => {});
  }

  _sleep(ms) {
    return new Promise(resolve => this.homey.setTimeout(resolve, ms));
  }

}

module.exports = WledStripDevice;
