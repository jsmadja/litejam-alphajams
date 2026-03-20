// ==UserScript==
// @name         Litejam × AlphaJams Standalone
// @namespace    https://github.com/litejam
// @version      1.0.0
// @description  Mirrors AlphaJams fretboard notes to the Litejam LED guitar via Web Bluetooth (no simulator server required)
// @author       Litejam
// @match        https://alphajams.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SERVICE_UUID  = '000000ee-0000-1000-8000-00805f9b34fb';
  const CHAR_UUID     = '0000ee04-0000-1000-8000-00805f9b34fb';
  const BATTERY_SERVICE_UUID = '000000ff-0000-1000-8000-00805f9b34fb';
  const BATTERY_CHAR_UUID    = '0000ff02-0000-1000-8000-00805f9b34fb';

  const SEND_DEBOUNCE_CLASS = 50;   // ms – fast path: note state change (class mutation)
  const SEND_DEBOUNCE_ANIM  = 150;  // ms – slow path: GSAP animation frame (style/transform)
  const LED_FRET_OFFSET = 12;       // shift all LED positions by this many frets

  // ── Web Bluetooth ─────────────────────────────────────────────────────────

  let bleCharacteristic = null;
  let bleSyncTimer = null;

  function cancelBleSync() {
    if (bleSyncTimer !== null) {
      clearTimeout(bleSyncTimer);
      bleSyncTimer = null;
    }
  }

  function scheduleBleSync() {
    if (!bleCharacteristic) return;
    cancelBleSync();
    bleSyncTimer = setTimeout(syncLedsToHardware, 50);
  }

  function encodeLedsForBle(leds) {
    // Group by color, then by fret; build string bitmasks
    const byColor = new Map();
    for (const { fret, string, r, g, b } of leds) {
      const key = `${r},${g},${b}`;
      if (!byColor.has(key)) byColor.set(key, new Map());
      const fretMap = byColor.get(key);
      fretMap.set(fret, (fretMap.get(fret) || 0) | (1 << (string - 1)));
    }

    // Packet: [segmentCount] ( [fretCount] [fret bitmask]… [r g b] )… [END]
    const bytes = [byColor.size];
    for (const [colorKey, fretMap] of byColor) {
      const [r, g, b] = colorKey.split(',').map(Number);
      bytes.push(fretMap.size);
      for (const [fret, bitmask] of fretMap) {
        bytes.push(fret, bitmask);
      }
      bytes.push(r, g, b);
    }
    bytes.push(0x45, 0x4e, 0x44); // END marker
    return new Uint8Array(bytes);
  }

  function syncLedsToHardware() {
    bleSyncTimer = null;
    if (!bleCharacteristic) return;
    const leds = [...activeNotes.values(), ...upcomingNotes.values()];
    const encoded = encodeLedsForBle(leds);
    bleCharacteristic.writeValueWithoutResponse(encoded).catch((e) => {
      console.warn('[Litejam] BLE write error:', e.message);
    });
  }

  async function connectBluetooth() {
    if (!navigator.bluetooth) {
      updateBadge('unsupported');
      alert('Web Bluetooth is not supported in this browser. Use Chrome or Edge.');
      return;
    }
    updateBadge('scanning');
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'Lite Jam RGB' }],
        optionalServices: [SERVICE_UUID, BATTERY_SERVICE_UUID],
      });
      updateBadge('connecting');
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      bleCharacteristic = await service.getCharacteristic(CHAR_UUID);
      updateBadge('connected');
      console.log('[Litejam] Connected via Web Bluetooth');

      device.addEventListener('gattserverdisconnected', () => {
        bleCharacteristic = null;
        updateBadge('disconnected');
        updateBatteryDisplay(null);
        console.log('[Litejam] BLE disconnected');
      });

      // Battery level (best-effort)
      try {
        const statusService = await server.getPrimaryService(BATTERY_SERVICE_UUID);
        const battChar = await statusService.getCharacteristic(BATTERY_CHAR_UUID);
        const battVal = await battChar.readValue();
        updateBatteryDisplay(battVal.getUint8(0));
        await battChar.startNotifications();
        battChar.addEventListener('characteristicvaluechanged', (e) => {
          updateBatteryDisplay(e.target.value.getUint8(0));
        });
      } catch (e) {
        console.warn('[Litejam] Battery service not available:', e.message);
        updateBatteryDisplay(null);
      }

      // Immediately sync current LED state
      syncLedsToHardware();
    } catch (e) {
      if (e.name !== 'NotFoundError') {
        console.error('[Litejam] Web Bluetooth error:', e);
        updateBadge('error');
      } else {
        updateBadge('disconnected');
      }
    }
  }

  // ── Floating UI ────────────────────────────────────────────────────────────

  function injectUI() {
    const panel = document.createElement('div');
    panel.id = 'litejam-panel';
    panel.style.cssText = [
      'position:fixed', 'bottom:16px', 'right:16px', 'z-index:999999',
      'display:flex', 'flex-direction:column', 'align-items:flex-end', 'gap:6px',
      'font-family:system-ui,sans-serif', 'font-size:13px',
    ].join(';');

    const btn = document.createElement('button');
    btn.id = 'litejam-connect-btn';
    btn.textContent = '🎸 Connect guitar';
    btn.style.cssText = [
      'padding:8px 14px', 'border-radius:8px', 'border:none', 'cursor:pointer',
      'background:#2563eb', 'color:#fff', 'font-weight:600', 'font-size:13px',
      'box-shadow:0 2px 8px rgba(0,0,0,.4)',
    ].join(';');
    btn.addEventListener('click', connectBluetooth);

    const badge = document.createElement('div');
    badge.id = 'litejam-badge';
    badge.style.cssText = [
      'padding:4px 10px', 'border-radius:6px', 'background:rgba(0,0,0,.6)',
      'color:#fff', 'display:none',
    ].join(';');

    const battery = document.createElement('div');
    battery.id = 'litejam-battery';
    battery.style.cssText = 'color:rgba(255,255,255,.5);display:none;';

    panel.appendChild(battery);
    panel.appendChild(badge);
    panel.appendChild(btn);
    document.body.appendChild(panel);
  }

  function updateBadge(status) {
    const badge = document.getElementById('litejam-badge');
    const btn   = document.getElementById('litejam-connect-btn');
    if (!badge) return;

    const cfg = {
      connected:    { icon: '🟢', label: 'Guitar: Connected',    color: '#16a34a' },
      scanning:     { icon: '🔍', label: 'Guitar: Scanning…',    color: '#d97706' },
      connecting:   { icon: '🔗', label: 'Guitar: Connecting…',  color: '#d97706' },
      disconnected: { icon: '⚠️', label: 'Guitar: Disconnected', color: '#dc2626' },
      error:        { icon: '❌', label: 'Guitar: Error',         color: '#dc2626' },
      unsupported:  { icon: '🚫', label: 'Bluetooth unsupported', color: '#6b7280' },
    };
    const { icon, label, color } = cfg[status] || { icon: '❓', label: status, color: '#6b7280' };

    badge.style.display = 'block';
    badge.style.background = color;
    badge.textContent = `${icon} ${label}`;

    if (btn) {
      btn.textContent = status === 'connected' ? '🎸 Reconnect' : '🎸 Connect guitar';
    }
  }

  function updateBatteryDisplay(pct) {
    const el = document.getElementById('litejam-battery');
    if (!el) return;
    if (pct === null || pct === undefined) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.textContent = `🔋 ${pct}%`;
    el.style.color = pct >= 50 ? '#22c55e' : pct >= 20 ? '#f59e0b' : '#ef4444';
  }

  // ── Coordinate → fret/string mapping ─────────────────────────────────────
  //
  // Source-code-confirmed formulas (alphajams/vendor.js):
  //
  //   Strings: d3 scaleLinear domain=[5,0] → range=[yFirst, yLast]
  //     → string index n is at y = yFirst + (5−n) * yStep
  //     → litejam string (1=high E … 6=low E) = 1 + (y − yFirst) / yStep
  //     Confirmed from DOM: yFirst=4, yStep=28, strings 1–6 at y=[4,32,60,88,116,144]
  //
  //   Frets: d3 scaleLinear domain=[minFret, maxFret] → range=[xFirst, xLast]
  //     → fret step = GCD of all Δx values (confirmed 40px in practice)
  //     → relativeFret = round((x − xMin) / xStep)
  //     → absoluteFret = relativeFret + fretOffset (fretOffset detected from Vue state)

  let xMin = null;
  let xStep = null;
  let yFirst = null;
  let yStep = null;
  let fretOffset = 0;

  function gcd(a, b) {
    return b < 1 ? a : gcd(b, a % b);
  }

  function detectLayout(groups) {
    const xs = new Set();
    const ys = new Set();
    groups.forEach((g) => {
      const { x, y } = parseTranslate(g.getAttribute('transform') || '');
      if (x === null || (x === 0 && y === 0)) return;
      xs.add(x);
      if (y !== null) ys.add(y);
    });

    const xArr = Array.from(xs).sort((a, b) => a - b);
    const yArr = Array.from(ys).sort((a, b) => a - b);

    if (xArr.length >= 2) {
      const diffs = [];
      for (let i = 1; i < xArr.length; i++) diffs.push(Math.round(xArr[i] - xArr[i - 1]));
      xMin = xArr[0];
      xStep = diffs.reduce((a, b) => gcd(a, b));
    }

    if (yArr.length >= 2) {
      yFirst = yArr[0];
      yStep = Math.round(yArr[1] - yArr[0]);
    }

    const svgEl = document.querySelector('.instrument-container svg');
    if (svgEl) {
      const comp = svgEl.__vueParentComponent || svgEl.__vue__;
      const min = comp?.props?.bounds?.min?.fret ?? comp?.ctx?.bounds?.min?.fret ?? null;
      if (min != null) {
        fretOffset = min;
        console.log('[Litejam] Fret offset from Vue state:', fretOffset);
      }
    }

    console.log(
      `[Litejam] Layout: xMin=${xMin} xStep=${xStep}px | yFirst=${yFirst} yStep=${yStep}px | fretOffset=${fretOffset}`,
    );
  }

  function parseTranslate(transform) {
    const m = transform.match(/translate\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/);
    if (!m) return { x: null, y: null };
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  }

  function xToFret(x) {
    if (xMin === null || xStep === null || xStep === 0) return 0;
    return Math.round((x - xMin) / xStep) + fretOffset + LED_FRET_OFFSET;
  }

  function yToString(y) {
    if (yFirst === null || yStep === null || yStep === 0) return 1;
    return Math.round(1 + (y - yFirst) / yStep);
  }

  // ── Active note state ──────────────────────────────────────────────────────

  let activeNotes   = new Map(); // key: "fret-string" → {fret, string, r, g, b}
  let upcomingNotes = new Map(); // key: "fret-string" → {fret, string, r, g, b}

  const ORANGE_R = 255;
  const ORANGE_G = 80;
  const ORANGE_B = 0;
  const OPACITY_THRESHOLD = 0.30;

  function parseRgb(fill) {
    const m = fill.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return null;
    return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) };
  }

  function getGroupColor(group) {
    const noteEl =
      group.querySelector('.instrument-note-elem') || group.querySelector('.instrument-note');
    if (!noteEl) return null;
    return parseRgb(getComputedStyle(noteEl).fill);
  }

  // ── Reconciliation ─────────────────────────────────────────────────────────

  let reconcileTimer = null;
  let reconcileTimerDelay = Infinity;

  function scheduleReconcile(delay) {
    if (reconcileTimer && delay >= reconcileTimerDelay) return;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimerDelay = delay;
    reconcileTimer = setTimeout(reconcile, delay);
  }

  function reconcile() {
    reconcileTimer = null;
    reconcileTimerDelay = Infinity;
    const container = document.querySelector('.instrument-container');
    if (!container) return;

    if (xMin === null || xStep === null) {
      const groups = Array.from(container.querySelectorAll('.instrument-note-group'));
      detectLayout(groups);
      if (xMin === null) return;
    }

    // ── Currently playing notes ────────────────────────────────────────────
    const newActive = new Map();
    container.querySelectorAll('.instrument-note-content.playing').forEach((content) => {
      const group = content.closest('.instrument-note-group');
      if (!group) return;
      const { x, y } = parseTranslate(group.getAttribute('transform') || '');
      if (x === null || y === null) return;
      const color = getGroupColor(group);
      if (!color) return;
      const fret   = xToFret(x);
      const string = yToString(y);
      console.log(`[Litejam] playing  x=${x} y=${y} → fret=${fret} string=${string} rgb(${color.r},${color.g},${color.b})`);
      newActive.set(`${fret}-${string}`, { fret, string, ...color });
    });

    // ── Upcoming (entering) notes ──────────────────────────────────────────
    const newUpcoming = new Map();
    container
      .querySelectorAll('.instrument-note-content.entering:not(.playing)')
      .forEach((content) => {
        const group = content.closest('.instrument-note-group');
        if (!group) return;
        const { x, y } = parseTranslate(group.getAttribute('transform') || '');
        if (x === null || y === null) return;
        const opacity = parseFloat(getComputedStyle(content).opacity);
        if (isNaN(opacity) || opacity < OPACITY_THRESHOLD) return;
        const fret   = xToFret(x);
        const string = yToString(y);
        if (newActive.has(`${fret}-${string}`)) return;
        const r = Math.round(ORANGE_R * opacity);
        const g = Math.round(ORANGE_G * opacity);
        const b = Math.round(ORANGE_B * opacity);
        console.log(`[Litejam] entering x=${x} y=${y} opacity=${opacity.toFixed(2)} → fret=${fret} string=${string} rgb(${r},${g},${b})`);
        newUpcoming.set(`${fret}-${string}`, { fret, string, r, g, b });
      });

    const mapsEqual = (a, b) =>
      a.size === b.size &&
      [...a.entries()].every(([k, v]) => {
        const e = b.get(k);
        return e && e.r === v.r && e.g === v.g && e.b === v.b;
      });

    const changed = !mapsEqual(newActive, activeNotes) || !mapsEqual(newUpcoming, upcomingNotes);

    if (changed) {
      activeNotes   = newActive;
      upcomingNotes = newUpcoming;
      const leds = [...activeNotes.values(), ...upcomingNotes.values()];
      console.log(`[Litejam] state changed → ${leds.length} LED(s):`, leds);
      scheduleBleSync();
    }
  }

  // ── MutationObserver ───────────────────────────────────────────────────────

  function startObserver(retries = 0) {
    const container = document.querySelector('.instrument-container');
    if (!container) {
      if (retries < 40) setTimeout(() => startObserver(retries + 1), 500);
      else console.warn('[Litejam] instrument-container not found after retries');
      return;
    }

    const groups = Array.from(container.querySelectorAll('.instrument-note-group'));
    if (groups.length === 0) {
      if (retries < 40) setTimeout(() => startObserver(retries + 1), 500);
      else console.warn('[Litejam] Note groups not found after retries');
      return;
    }

    detectLayout(groups);
    reconcile();

    const observer = new MutationObserver((mutations) => {
      const hasClassChange = mutations.some((m) => m.type === 'childList' || m.attributeName === 'class');
      scheduleReconcile(hasClassChange ? SEND_DEBOUNCE_CLASS : SEND_DEBOUNCE_ANIM);
    });

    observer.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'fill', 'style', 'transform'],
    });

    console.log('[Litejam] Observer started on', container, `(${groups.length} note groups)`);
  }

  // ── Boot ───────────────────────────────────────────────────────────────────

  injectUI();
  startObserver();

  // Handle Vue SPA route changes
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      xMin = null;
      xStep = null;
      yFirst = null;
      yStep = null;
      fretOffset = 0;
      activeNotes   = new Map();
      upcomingNotes = new Map();
      // Clear the guitar immediately
      if (bleCharacteristic) {
        const empty = encodeLedsForBle([]);
        bleCharacteristic.writeValueWithoutResponse(empty).catch(() => {});
      }
      setTimeout(() => startObserver(), 1000);
    }
  }, 500);
})();
