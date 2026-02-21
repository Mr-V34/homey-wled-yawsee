'use strict';

/**
 * Convert Homey's HSV values to RGB for WLED.
 *
 * @param {number} h - Hue 0–1
 * @param {number} s - Saturation 0–1
 * @param {number} v - Value/brightness 0–1
 * @returns {[number, number, number]} RGB 0–255
 */
function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: [r, g, b] = [v, t, p]; break;
    case 1: [r, g, b] = [q, v, p]; break;
    case 2: [r, g, b] = [p, v, t]; break;
    case 3: [r, g, b] = [p, q, v]; break;
    case 4: [r, g, b] = [t, p, v]; break;
    case 5: [r, g, b] = [v, p, q]; break;
    default: [r, g, b] = [0, 0, 0];
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * Convert Homey's light_temperature (0=cold, 1=warm) to an RGB white.
 * Interpolates between 6500 K (cool white) and 2700 K (warm white).
 *
 * @param {number} ct - 0 (cold) to 1 (warm)
 * @returns {[number, number, number]} RGB 0–255
 */
function ctToRgb(ct) {
  const cold = [200, 220, 255]; // ~6500 K
  const warm = [255, 147, 41];  // ~2700 K
  return [
    Math.round(cold[0] + (warm[0] - cold[0]) * ct),
    Math.round(cold[1] + (warm[1] - cold[1]) * ct),
    Math.round(cold[2] + (warm[2] - cold[2]) * ct),
  ];
}

module.exports = { hsvToRgb, ctToRgb };
