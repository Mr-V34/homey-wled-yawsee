# YAWSEE — Manual

A short guide to the Homey app for **WLED** LED strips.

🇬🇧 [English](#english) · 🇸🇪 [Svenska](#svenska)

---

## English

### How it works

YAWSEE talks to your WLED controller directly over your local network using WLED's
JSON API. No cloud account is needed. When the strip turns on or off, the LEDs
light up (or go dark) one by one. Turning the device on or off in Homey, or using the Slide flow cards, runs the animation.

The animation frames are sent to WLED as UDP realtime packets, which is much faster
than one web request per LED. If UDP realtime is turned off in WLED, the app falls
back to the slower JSON API by itself.

### Adding a device

1. Make sure the WLED controller is on the same network as Homey.
2. In Homey, add a device and choose **YAWSEE → WLED Strip**.
3. Pick your WLED device from the list and press **Connect**.
4. Not in the list? Choose **Enter IP manually** and type its address, for example
   `192.168.1.50`.

The number of LEDs is read from WLED when you add the device.

### Device controls

| Control | What it does |
|---|---|
| **On/off** | Slides the strip on or off. |
| **Brightness** | Sets the WLED brightness. |
| **Colour / Warm–Cool** | Sets the strip colour or white temperature. |

Homey checks the on/off state and brightness on the WLED device every 30 seconds, so
changes made in the WLED app show up in Homey.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| **Number of LEDs** | from WLED | Must match the real number of LEDs on the strip (1–1024). |
| **Slide speed (ms per LED)** | 25 | Time per LED step (0–500). 0 = as fast as possible. 25 ms × 40 LEDs = 1 second. |
| **Reverse direction** | off | Run the animation right to left instead of left to right. |
| **WLED Firmware** | — | The WLED version (read only). |
| **IP Address** | — | The address of the device (read only). |

### Flow cards

| Type | Card | What it does |
|---|---|---|
| Action | **Slide ON** | LEDs light up one by one from start to end, then stay on. |
| Action | **Slide OFF** | LEDs go dark one by one from end to start, then the strip turns off. |
| Action | **Set slide direction** | Left to right, or right to left. |
| Action | **Set slide speed** | Milliseconds per LED (0–500). |
| Trigger | **Sliding effect finished** | Runs when an animation is done. Token: *Slide direction* (`on`/`off`). |

### Troubleshooting

- **Device not found during pairing:** check that WLED is powered and on the same
  network, or add it by IP address.
- **Device shows as unavailable:** Homey could not reach WLED. Check power and Wi-Fi.
  It becomes available again by itself once WLED answers.
- **Animation is slow:** in WLED, open *Config → Sync Interfaces* and check that
  *Receive UDP realtime* is on. Restart the YAWSEE app afterwards.
- **Animation does not cover the whole strip:** check that *Number of LEDs* matches your strip.

---

## Svenska

### Så fungerar det

YAWSEE pratar direkt med din WLED-styrenhet över det lokala nätverket via WLED:s
JSON-API. Inget molnkonto behövs. När slingan tänds eller släcks gör lysdioderna det
en i taget. Animationen körs när du slår
på eller av enheten i Homey, eller när du använder Flow-korten för glidning.

Animationen skickas till WLED som UDP-realtidspaket, vilket går mycket snabbare än en
webbförfrågan per lysdiod. Om UDP-realtid är avstängt i WLED använder appen
automatiskt det långsammare JSON-API:et.

### Lägga till en enhet

1. Se till att WLED-styrenheten är på samma nätverk som Homey.
2. Lägg till en enhet i Homey och välj **YAWSEE → WLED-slinga**.
3. Välj din WLED-enhet i listan och tryck på **Anslut**.
4. Syns den inte i listan? Välj **Ange IP-adressen manuellt** och skriv in adressen,
   till exempel `192.168.1.50`.

Antalet lysdioder hämtas från WLED när du lägger till enheten.

### Reglage på enheten

| Reglage | Vad det gör |
|---|---|
| **På/av** | Glider på eller av slingan. |
| **Ljusstyrka** | Ställer in ljusstyrkan i WLED. |
| **Färg / Varm–Kall** | Ställer in färg eller vit färgtemperatur. |

Homey läser av på/av-läge och ljusstyrka från WLED-enheten var 30:e sekund, så
ändringar som görs i WLED-appen syns i Homey.

### Inställningar

| Inställning | Standard | Betydelse |
|---|---|---|
| **Antal lysdioder** | från WLED | Måste stämma med antalet lysdioder på slingan (1–1024). |
| **Glidhastighet (ms per lysdiod)** | 25 | Tid per lysdiod (0–500). 0 = så snabbt som möjligt. 25 ms × 40 lysdioder = 1 sekund. |
| **Omvänd riktning** | av | Kör animationen från höger till vänster i stället för vänster till höger. |
| **WLED-firmware** | — | WLED-versionen (visas bara). |
| **IP-adress** | — | Enhetens adress (visas bara). |

### Flow-kort

| Typ | Kort | Vad det gör |
|---|---|---|
| Åtgärd | **Glid PÅ** | Lysdioderna tänds en i taget från början till slut och lyser sedan kvar. |
| Åtgärd | **Glid AV** | Lysdioderna släcks en i taget från slut till början, sedan stängs slingan av. |
| Åtgärd | **Ställ in glidriktning** | Vänster till höger, eller höger till vänster. |
| Åtgärd | **Ställ in glidhastighet** | Millisekunder per lysdiod (0–500). |
| Utlösare | **Glideffekten är klar** | Körs när en animation är klar. Token: *Glidriktning* (`on`/`off`). |

### Felsökning

- **Enheten hittas inte vid parkoppling:** kontrollera att WLED har ström och är på
  samma nätverk, eller lägg till den via IP-adress.
- **Enheten visas som otillgänglig:** Homey når inte WLED. Kontrollera ström och wifi.
  Den blir tillgänglig igen av sig själv när WLED svarar.
- **Animationen går långsamt:** öppna *Config → Sync Interfaces* i WLED och kontrollera
  att *Receive UDP realtime* är på. Starta sedan om YAWSEE-appen.
- **Animationen täcker inte hela slingan:** kontrollera att *Antal lysdioder* stämmer med slingan.
