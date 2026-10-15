'use strict';

const Homey   = require('homey');
const wled                  = require('../../lib/wled-api');
const { assertValidIp }     = require('../../lib/wled-api');
const { hsvToRgb, ctToRgb } = require('../../lib/color-utils');
const { WledUdpSender, DEFAULT_PORT, gammaCorrect } = require('../../lib/wled-udp');

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

    this._animating    = false;  // true while a slide runs: new slides are ignored, poll waits
    this._stopped      = false;  // set on delete/uninit: a running slide stops
    this._pollTimer    = null;
    this._udpEnabled   = false;  // true when WLED accepts UDP realtime (checked from /json/cfg)
    this._udpChecked   = false;
    this._udpPort      = DEFAULT_PORT;
    this._udpGamma     = 1;

    // UDP realtime sender: one packet per animation frame instead of one HTTP request
    this._udp = new WledUdpSender();
    try {
      this._udp.open();
    } catch (err) {
      this.log(`UDP unavailable (${err.message}), slides switch without animation`);
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
    // Not awaited: an unreachable WLED must not delay start-up. A slide checks
    // again if this has not finished.
    this._detectUdp().catch(this.error);

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
    this._stopped = true;
    this._stopPolling();
    this._closeUdp();
  }

  async onUninit() {
    this._stopped = true;
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
  // The animation is sent to WLED as UDP realtime frames, one frame per LED
  // step. The lit part grows (on) or shrinks (off) from the start of the
  // strip (the end if reversed), with one dim LED at the moving edge
  // (TAIL_BRIGHTNESS). WLED pauses its own rendering while frames arrive.
  // The final state is set over HTTP behind the frames, and the last packet
  // ends realtime mode at once, so WLED shows that state without a jump.
  //
  // A slide always runs to the end. A request (button or flow) that comes in
  // while a slide is running is ignored. Without UDP realtime (off in WLED,
  // port 0, or a socket error) the strip switches on or off at once.

  async slideOn() {
    await this._slide(true);
  }

  async slideOff() {
    await this._slide(false);
  }

  async _slide(isOn) {
    const name = isOn ? 'slideOn' : 'slideOff';
    if (this._animating) {
      this.log(`${name}: ignored, a slide is running`);
      return;
    }
    this._animating = true;

    try {
      const reverse = this.getSetting('reverse') || false;
      const { leds, speed, color } = this._effectParams();
      const bri  = Math.round((this.getCapabilityValue('dim') ?? 1) * 255);
      const full = {
        on: true, bri, transition: 0,
        seg: [
          { id: 0, start: 0, stop: leds, col: [color, BLACK, BLACK], fx: 0 },
          { id: 1, start: 0, stop: 0 },
        ],
      };
      const final = isOn ? full : { ...full, on: false };

      if (!this._udpChecked) await this._detectUdp();
      const animated = await this._slideUdp(leds, speed, color, reverse, isOn, full, final);
      if (this._stopped) return;
      if (!animated) {
        this.log(`${name}: no UDP realtime, switching without animation`);
        await this._wledPost(final);
      }

      await this.setCapabilityValue('onoff', isOn).catch(this.error);
      this.log(`${name}: complete (${reverse ? 'reverse' : 'forward'})`);
      await this._slideDoneTrigger.trigger(this, { direction: isOn ? 'on' : 'off' }, {});

    } catch (err) {
      if (this._stopped) return;
      this.error(`${name} failed:`, err.message);
      await this.setUnavailable(this.homey.__('errors.offline_reason', { reason: err.message }));
    } finally {
      this._animating = false;
    }
  }

  // Runs the slide as UDP frames. Returns true when it was shown (the final
  // state is then already set), false when UDP is not available or a send
  // failed. HTTP errors are thrown: WLED itself is unreachable.

  async _slideUdp(leds, speed, color, reverse, isOn, full, final) {
    const udp = this._udp;
    if (!udp || !this._udpEnabled) return false;

    const ip    = this.getStoreValue('address');
    const port  = this._udpPort;
    const delay = Math.max(UDP_MIN_FRAME_MS, speed);
    // WLED gamma-corrects segment colours but not UDP pixels: do it here so
    // the frames match the colour WLED shows when realtime mode ends.
    const lit   = gammaCorrect(color, this._udpGamma);
    const tip   = gammaCorrect(color.map(c => Math.round(c * TAIL_BRIGHTNESS)), this._udpGamma);
    const at    = k => (reverse ? leds - 1 - k : k);   // LED index of the k-th LED from the start end
    // On starts dark and fills up; off starts full and clears from the far end
    const frame = Array.from({ length: leds }, () => (isOn ? BLACK : lit));
    const send  = () => udp.sendFrame(ip, port, frame).catch(err => { err.udp = true; throw err; });

    let posted = false;
    try {
      for (let step = 0; step < leds; step++) {
        if (this._stopped) return true;
        const k = isOn ? step : leds - 1 - step;
        if (step > 0) frame[at(isOn ? k - 1 : k + 1)] = isOn ? lit : BLACK;
        frame[at(k)] = tip;
        await Promise.all([send(), this._sleep(delay)]);
        // After the first frame WLED is in realtime mode, so setting the
        // state now does not show on the strip yet. It is set to on even for
        // a slide off, so the frames are visible when the strip was off.
        if (!posted) { await this._wledPost(full); posted = true; }
      }
      if (this._stopped) return true;
      frame[at(isOn ? leds - 1 : 0)] = isOn ? lit : BLACK;
      await send();
      if (!isOn) await this._wledPost(final);
      await udp.exitRealtime(ip, port);
      this.log(`slide (UDP): ${isOn ? 'on' : 'off'}, ${leds} LEDs, ${delay} ms per step`);
      return true;

    } catch (err) {
      if (this._stopped) return true;
      if (!err.udp) throw err;
      // A UDP send error is local (socket closed or network down on Homey)
      this.error('slide (UDP) failed:', err.message);
      await udp.exitRealtime(ip, port).catch(() => {});
      this._udpEnabled = false;
      this._udpChecked = false;  // check again on the next slide or poll
      return false;
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
      // WLED does not listen for UDP at all when its port is 0 (wled.cpp)
      const rawPort = cfg?.if?.sync?.port0;
      const port    = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
      const portOk  = Number.isInteger(port) && port > 0 && port < 65536;
      this._udpEnabled = cfg?.if?.live?.en !== false && portOk;
      this._udpPort    = portOk ? port : DEFAULT_PORT;
      const gcCol = Number(cfg?.light?.gc?.col);
      const gcVal = Number(cfg?.light?.gc?.val);
      const wledDoesUdpGamma = cfg?.if?.live?.['no-gc'] === false;
      this._udpGamma = (!wledDoesUdpGamma && gcCol > 1 && gcVal > 1 && gcVal <= 3) ? gcVal : 1;
      this._udpChecked = true;
      this.log(this._udpEnabled
        ? `UDP realtime: on (port ${this._udpPort}, gamma ${this._udpGamma})`
        : 'UDP realtime: off in WLED (or port 0), slides switch without animation');
    } catch (err) {
      this._udpEnabled = false;
      this.log(`UDP check failed (${err.message}), will check again`);
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
