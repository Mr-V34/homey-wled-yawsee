YAWSEE v2.0.0 - The Sliding Effect!


  🚀 First Stable Release!

  Welcome to YAWSEE v2.0.0, a complete overhaul designed to bring a premium, dynamic lighting experience to your WLED strips! This version introduces the highly anticipated "Sliding
  Effect," transforming how your lights turn on and off.

  ✨ New Features


   * Introducing the Sliding Effect!
       * Experience a sophisticated "sliding" animation as your LED strips gracefully turn on and off, adding a modern and cinematic flair to your lighting.
       * Customizable slide_speed_ms and transition_ms settings allow you to fine-tune the animation to your preference.
       * Dedicated Flow Action cards (Slide On, Slide Off) and a Trigger card (Slide Completed) enable seamless integration into your Homey flows.
   * Enhanced WLED Integration:
       * Robust and efficient communication with WLED devices using their native JSON API.
       * Full support for Homey's onoff, dim, light_hue, light_saturation, and light_temperature capabilities.
   * Intuitive Device Pairing:
       * Automatic mDNS discovery quickly finds WLED devices on your network.
       * Manual IP entry option for devices that aren't automatically discovered.
   * New Visual Assets:
       * All-new, high-quality icons and promotional images for a polished App Store presence and a consistent in-app experience.

  🛡️ Security & Stability Improvements


   * Hardened Input Validation: Rigorous clamping and Number.isFinite() checks for all settings and flow card inputs prevent invalid values from causing unexpected behavior or device
     instability.
   * Robust Data Handling: Enhanced sanitisation and validation of data received from WLED devices (e.g., device names, firmware versions, brightness values) to protect against malicious
     input.
   * Improved Error Handling: Comprehensive error catching ensures the app remains stable even if WLED devices go offline or respond unexpectedly.

  🐛 Bug Fixes & Optimizations


   * Resolved issues with NaN/Infinity values bypassing clamping logic in slide speed settings, preventing potential WLED device flooding.
   * Corrected handling of WLED brightness values during polling, ensuring accurate dim capability representation in Homey.
   * Optimized polling mechanism to prevent state conflicts during active slide animations.
