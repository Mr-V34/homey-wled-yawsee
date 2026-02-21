# YAWSEE — Yet Another WLED Slide & Exit Effect

A Homey app for WLED LED strips that adds a **worm/snake sliding animation** when turning your strip on or off.

## How it works

**Slide ON** — LEDs fill one by one from start to end, with a dim leading-edge glow ahead of the bright body.

**Slide OFF** — LEDs clear one by one from end to start, leaving a dim trailing echo on the last LED as the bright body retreats.

The effect uses two simultaneous WLED segments: the full-brightness body and a 35%-brightness tail LED that always tracks the edge.

## Requirements

- WLED firmware **0.14 or newer** (tested on 0.15)
- ESP32 or ESP8266 with an addressable LED strip (WS2812B, SK6812, etc.)
- Homey Pro (2023) or Homey Pro (Early 2023)

## Installation

1. Install this app from the [Homey App Store](https://apps.homey.app)
2. Add a device — YAWSEE will auto-discover WLED devices on your network via mDNS, or you can enter the IP manually
3. Set **Number of LEDs** in device settings to match your physical strip

## Device settings

| Setting | Default | Description |
|---------|---------|-------------|
| Number of LEDs | 20 | Must match your physical LED count |
| Slide speed | 50 ms | Time per LED step (10–500 ms) |

## Flow cards

**Actions**
- Slide ON — trigger the fill animation
- Slide OFF — trigger the clear animation
- Set slide speed — change the speed at runtime (ms per LED)

**Triggers**
- Sliding effect finished — fires when an animation completes, with a `direction` token (`on` / `off`)

## Notes

- WLED's HTTP API is used over the local LAN — no cloud, no external traffic
- mDNS re-discovery keeps the IP address up to date after reboots or DHCP changes
- Turning on while sliding off (or vice versa) cancels the current animation immediately

## License

MIT
