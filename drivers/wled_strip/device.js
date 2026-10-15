'use strict';

const Homey   = require('homey');
const wled                  = require('../../lib/wled-api');
const { assertValidIp }     = require('../../lib/wled-api');
const { hsvToRgb, ctToRgb } = require('../../lib/color-utils');
const { WledUdpSender, DEFAULT_PORT, validPort, gammaCorrect } = require('../../lib/wled-udp');

// How often to poll WLED for current state (ms)
const POLL_INTERVAL_MS = 30_000;

// Worm-tail brightness as a fraction of the main color (0 = off, 1 = full)
const TAIL_BRIGHTNESS = 0.35;

// Shortest time between UDP frames, so the ESP's receive buffer keeps up
const UDP_MIN_FRAME_MS = 2;
const BLACK = [0, 0, 0];

class WledStripDevice extends Homey.Device {

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async onInit() {
    this.log(`Device init: "${this.getName()}" @ ${this.getStoreValue('address')}`);

    this._slideGen     = 0;      // M-04: increments on each new animation; cancels the previous
    this._animating    = false;  // true while any slide animation is running (suppresses poll)
    this._pollTimer    = null;
    this._udpEnabled   = false;  // true when WLED accepts UDP realtime (checked from /json/cfg)
    this._udpChecked   = false;
    this._udpPort      = DEFAULT_PORT;
    this._udpGamma     = 1;
    // LEDs lit right now (0 = off, num_leds = on); lets a new slide reverse mid-strip
    this._animPos      = this.getCapabilityValue('onoff') ? this._effectParams().leds : 0;

    // UDP realtime sender: one packet per animation frame instead of one HTTP request
    this._udp = new WledUdpSender();
    try {
      this._udp.open();
    } catch (err) {
      this.log(`UDP unavailable (${err.message}), using HTTP`);
      this._udp = null;
    }

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
    await this._detectUdp();

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
    this._closeUdp();
  }

  async onUninit() {
    this._stopPolling();
    this._closeUdp();
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys.join(', '));

    // SECURITY: clamp num_leds so a rogue value can't cause a runaway loop
    if (changedKeys.includes('num_leds')) {
      const clamped = Math.max(1, Math.min(1024, Math.round(newSettings.num_leds)));
      if (clamped !== newSettings.num_leds) {
        throw new Error(this.homey.__('settings.num_leds_range', { value: newSettings.num_leds }));
      }
    }

    if (changedKeys.includes('slide_speed_ms')) {
      const v = newSettings.slide_speed_ms;
      if (v < 0 || v > 500) throw new Error(this.homey.__('settings.speed_range'));
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
    await this._detectUdp();
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
      const udp = await this._slideUdp(gen, leds, speed, color, tailColor, bri, reverse, true);
      if (udp === 'superseded') return;
      const udpDone = udp === 'done';
      if (!udpDone && !reverse) {
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
      } else if (!udpDone) {
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
      this._animPos = leds;
      await this.setCapabilityValue('onoff', true).catch(this.error);
      this.log('slideOn: complete');
      await this._slideDoneTrigger.trigger(this, { direction: 'on' }, {});

    } catch (err) {
      if (this._slideGen !== gen) return;
      this.error('slideOn failed:', err.message);
      await this.setUnavailable(this.homey.__('errors.offline_reason', { reason: err.message }));
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
      const udp = await this._slideUdp(gen, leds, speed, color, tailColor, bri, reverse, false);
      if (udp === 'superseded') return;
      const udpDone = udp === 'done';
      // Both directions start from a full lit strip
      if (!udpDone) await this._wledPost({
        on: true, bri, transition: 0,
        seg: [
          { id: 0, start: 0, stop: leds, col: [color, [0,0,0], [0,0,0]], fx: 0 },
          { id: 1, start: 0, stop: 0 },
        ],
      });

      if (udpDone) {
        // already animated over UDP
      } else if (!reverse) {
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
      this._animPos = 0;
      await this.setCapabilityValue('onoff', false).catch(this.error);
      this.log('slideOff: complete');
      await this._slideDoneTrigger.trigger(this, { direction: 'off' }, {});

    } catch (err) {
      if (this._slideGen !== gen) return;
      this.error('slideOff failed:', err.message);
      await this.setUnavailable(this.homey.__('errors.offline_reason', { reason: err.message }));
    } finally {
      if (this._slideGen === gen) this._animating = false;
    }
  }

  // ── UDP realtime animation ───────────────────────────────────────────────
  //
  // Same worm look as the HTTP path, but each step is one UDP frame on
  // WLED's notifier port instead of one HTTP request. WLED pauses its own
  // rendering while frames arrive and applies colour order and brightness.
  // The final HTTP state is set behind the frames, and the last packet
  // ends realtime mode at once, so WLED shows that state without a jump.
  //
  // The lit part always grows from the same end (start, or end if reversed)
  // and this._animPos holds how many LEDs are lit. A new slide continues from
  // there, so switching on/off quickly turns the worm around mid-strip.
  //
  // Returns 'done', 'superseded' (a newer animation took over) or 'skipped'
  // (UDP not available or failed before anything was shown: use HTTP).

  async _slideUdp(gen, leds, speed, color, tailColor, bri, reverse, isOn) {
    if (!this._udp || !this._udpEnabled) return 'skipped';

    const ip    = this.getStoreValue('address');
    const port  = this._udpPort;
    const delay = Math.max(UDP_MIN_FRAME_MS, speed);
    const full  = {
      on: true, bri, transition: 0,
      seg: [
        { id: 0, start: 0, stop: leds, col: [color, BLACK, BLACK], fx: 0 },
        { id: 1, start: 0, stop: 0 },
      ],
    };
    // WLED gamma-corrects segment colours but not UDP pixels: do it here so
    // the frames match the colour WLED shows when realtime mode ends.
    const lit   = gammaCorrect(color, this._udpGamma);
    const tip   = gammaCorrect(tailColor, this._udpGamma);
    const at    = k => (reverse ? leds - 1 - k : k);   // LED index of the k-th lit LED
    const from  = Math.max(0, Math.min(leds, Math.round(this._animPos)));
    const frame = Array.from({ length: leds }, () => BLACK);
    for (let k = 0; k < from; k++) frame[at(k)] = lit;

    let posted = false;
    try {
      if (isOn) {
        for (let k = from; k < leds; k++) {
          if (this._slideGen !== gen) { this.log('slide (UDP): superseded'); return 'superseded'; }
          if (k > from) frame[at(k - 1)] = lit;
          frame[at(k)] = tip;
          this._animPos = k;
          await Promise.all([this._udp.sendFrame(ip, port, frame), this._sleep(delay)]);
          // After the first frame WLED is in realtime mode, so setting the
          // final state now does not show on the strip yet.
          if (!posted) { await this._wledPost(full); posted = true; }
        }
        if (this._slideGen !== gen) return 'superseded';
        if (leds > from) frame[at(leds - 1)] = lit;
        await this._udp.sendFrame(ip, port, frame);
        if (!posted) await this._wledPost(full);
        this._animPos = leds;
      } else {
        for (let k = from - 1; k >= 0; k--) {
          if (this._slideGen !== gen) { this.log('slide (UDP): superseded'); return 'superseded'; }
          if (k < from - 1) frame[at(k + 1)] = BLACK;
          frame[at(k)] = tip;
          this._animPos = k;
          await Promise.all([this._udp.sendFrame(ip, port, frame), this._sleep(delay)]);
        }
        if (this._slideGen !== gen) return 'superseded';
        if (from > 0) frame[at(0)] = BLACK;
        await this._udp.sendFrame(ip, port, frame);
        await this._wledPost({ ...full, on: false });
        this._animPos = 0;
      }
      await this._udp.exitRealtime(ip, port);
      this.log(`slide (UDP): ${isOn ? 'on' : 'off'} from ${from}/${leds} LEDs, ${delay} ms per step`);
      return 'done';

    } catch (err) {
      if (this._slideGen !== gen) return 'superseded';
      // A UDP send error is local (socket); HTTP errors mean WLED is unreachable.
      this.error('slide (UDP) failed, using HTTP:', err.message);
      // Leave realtime mode so the HTTP animation is visible right away
      if (this._udp) await this._udp.exitRealtime(ip, port).catch(() => {});
      this._udpEnabled = false;
      this._udpChecked = false;  // check again on the next successful poll
      return 'skipped';
    }
  }

  // Read from WLED whether UDP realtime is on, its port, and the colour gamma
  // it uses for normal output (cfg.cpp: gc.col > 1 enables it, gc.val is the
  // exponent, valid range 1–3). If WLED gamma-corrects UDP itself (no-gc
  // false), we must not do it twice.
  async _detectUdp() {
    const ip = this.getStoreValue('address');
    if (!ip || !this._udp) return;
    try {
      const cfg  = await wled.getConfig(ip);
      // Untrusted input: only accept an explicit false / valid numbers
      this._udpEnabled = cfg?.if?.live?.en !== false;
      this._udpPort    = validPort(cfg?.if?.sync?.port0);
      const gcCol = Number(cfg?.light?.gc?.col);
      const gcVal = Number(cfg?.light?.gc?.val);
      const wledDoesUdpGamma = cfg?.if?.live?.['no-gc'] === false;
      this._udpGamma = (!wledDoesUdpGamma && gcCol > 1 && gcVal > 1 && gcVal <= 3) ? gcVal : 1;
      this._udpChecked = true;
      this.log(this._udpEnabled
        ? `UDP realtime: on (port ${this._udpPort}, gamma ${this._udpGamma})`
        : 'UDP realtime: off in WLED, using HTTP');
    } catch (err) {
      this._udpEnabled = false;
      this.log(`UDP check failed (${err.message}), using HTTP for now`);
    }
  }

  _closeUdp() {
    if (this._udp) {
      this._udp.close();
      this._udp = null;
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
      if (!this._udpChecked) await this._detectUdp();

      await this.setCapabilityValue('onoff', Boolean(state.on));
      this._animPos = state.on ? this._effectParams().leds : 0;
      // SECURITY: clamp bri from untrusted WLED response to valid 0-255 range
      const bri = Math.max(0, Math.min(255, Number(state.bri) || 128));
      await this.setCapabilityValue('dim', bri / 255);
      await this.setAvailable();

    } catch (err) {
      this.error('Poll failed:', err.message);
      await this.setUnavailable(this.homey.__('errors.offline_reason', { reason: err.message }));
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _effectParams() {
    const s          = this.getSettings();
    // SECURITY: fallback to safe defaults if settings are NaN/undefined
    const rawLeds    = Number(s.num_leds);
    const leds       = Number.isFinite(rawLeds) ? Math.max(1, Math.min(1024, Math.round(rawLeds))) : 20;
    const rawSpeed   = Number(s.slide_speed_ms);
    const speed      = Number.isFinite(rawSpeed) ? Math.max(0, Math.min(500, Math.round(rawSpeed))) : 25;

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
