# litejam-alphajams

A Tampermonkey userscript that connects your [LiteJam RGB guitar](https://litejam.com/) to [AlphaJams](https://alphajams.com/) backing tracks via Web Bluetooth. When a backing track plays, the notes to play are automatically highlighted on the guitar's LED fretboard in real time.

---

## Features

- 🎸 One-click Bluetooth connection to your LiteJam guitar from the AlphaJams website
- 💡 Real-time LED synchronisation: active (currently playing) and upcoming (entering) notes are mirrored onto the guitar's fretboard
- 🔋 Battery level display once connected
- 🔄 Handles Vue SPA route changes automatically (no page reload needed when switching tracks)

---

## Requirements

| Requirement | Details |
|---|---|
| Browser | Google Chrome or Microsoft Edge (Web Bluetooth is not supported in Firefox or Safari) |
| Browser extension | [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) |
| Hardware | LiteJam RGB guitar |
| Account | An [AlphaJams](https://alphajams.com/) account |

---

## Installation

1. **Install the Tampermonkey extension** in Chrome or Edge:
   [https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)

2. **Add the userscript**:
   - Click the Tampermonkey icon in your browser toolbar and select **Create a new script…**
   - Delete all placeholder content in the editor
   - Copy the entire contents of [`litejam.alphajams.standalone.js`](./litejam.alphajams.standalone.js) and paste it into the editor
   - Press **Ctrl+S** (or **Cmd+S** on macOS) to save

3. **Navigate to an AlphaJams backing track** (e.g. `https://alphajams.com/...`). A **🎸 Connect guitar** button will appear in the bottom-right corner of the page.

4. **Click the button** and select your LiteJam guitar from the Bluetooth device picker. The button changes to **🎸 Reconnect** once the connection is established.

5. **Press Play** on the backing track. The guitar LEDs will light up the notes in sync with the music.

---

## Usage

| Button / indicator | Meaning |
|---|---|
| 🎸 Connect guitar | Opens the Bluetooth device picker |
| 🟢 Guitar: Connected | Successfully paired with the guitar |
| 🔍 Guitar: Scanning… | Searching for devices |
| 🔗 Guitar: Connecting… | Pairing in progress |
| ⚠️ Guitar: Disconnected | Connection was lost — click the button to reconnect |
| ❌ Guitar: Error | A Bluetooth error occurred |
| 🚫 Bluetooth unsupported | Your browser does not support Web Bluetooth |
| 🔋 *n*% | Current battery level of the connected guitar |

---

## Technical details

### Web Bluetooth communication

The script communicates with the guitar over Bluetooth Low Energy (BLE) using two GATT services:

| Service | UUID | Purpose |
|---|---|---|
| LED control | `000000ee-0000-1000-8000-00805f9b34fb` | Send LED fret/string/colour data |
| Battery | `000000ff-0000-1000-8000-00805f9b34fb` | Read and receive notifications for battery level |

The LED control characteristic UUID is `0000ee04-0000-1000-8000-00805f9b34fb`. Data is sent with `writeValueWithoutResponse` to minimise latency.

### BLE packet format

Each packet encodes a list of LEDs grouped by colour:

```
[segmentCount]
  For each colour segment:
    [fretCount]
    For each fret in the segment:
      [fret] [stringBitmask]   (stringBitmask: bit 0 = string 1, …, bit 5 = string 6)
    [R] [G] [B]
[0x45 0x4E 0x44]  (ASCII "END" marker)
```

### DOM observation and coordinate mapping

The script watches the AlphaJams fretboard (`.instrument-container`) using a `MutationObserver`. When DOM mutations are detected, a reconciliation pass reads all `.instrument-note-content.playing` elements (active notes) and `.instrument-note-content.entering` elements (upcoming notes).

Each note group carries a `transform="translate(x, y)"` attribute. The script derives the fret and string numbers from these pixel coordinates using linear mappings calibrated from the actual SVG layout:

- **Fret**: `round((x − xMin) / xStep) + fretOffset + LED_FRET_OFFSET`
- **String**: `round(1 + (y − yFirst) / yStep)` (string 1 = high E, string 6 = low E)

`fretOffset` is read directly from the Vue component state of the fretboard SVG so the mapping stays accurate regardless of which section of the neck is displayed. `LED_FRET_OFFSET` (default 12) compensates for the physical position of the LED strip on the guitar body.

Upcoming notes are rendered with reduced opacity; the colour sent to the guitar is the note's normal colour multiplied by the current opacity, creating a fade-in effect on the LEDs.

### SPA route change handling

AlphaJams is a Vue single-page application. The script polls `location.href` every 500 ms and, on a route change, resets all layout state and restarts the observer so the LED mapping adapts to the new track automatically.
