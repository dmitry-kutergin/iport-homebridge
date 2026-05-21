# homebridge-iport-bezel

A [Homebridge](https://homebridge.io) platform plugin for [iPort Surface Mount Buttons](https://www.iportproducts.com/products/surface-mount-buttons/) (SM Buttons / SM Bezel — 6- and 10-button models).

Each bezel is exposed to HomeKit as a single accessory whose buttons appear as numbered `StatelessProgrammableSwitch` services. Button presses are surfaced as **single press**, **double press**, and **long press** events that can drive any HomeKit automation.

## Features

- Multiple bezels in one platform — list them in `config.json`.
- Persistent caching of accessories across Homebridge restarts.
- Automatic TCP reconnect to each bezel (5 s back-off) and periodic LED-query keep-alive (60 s).
- Single / double / long press detection (server-side, see [Gesture timing](#gesture-timing)).
- HomeKit "ServiceLabel" pattern — buttons appear numbered 1…10 in the Home app and can be individually renamed.
- Auto-reconciliation with the bezel's auto-repeat behavior — one held button produces exactly one long-press event.
- Per-bezel **Lightbulb** service for full HSB color control of the LEDs.
- Visual press confirmation — every recognized press briefly flicks the LEDs to green (or its inverse if the LEDs are already green) so the user sees the gesture was registered.
- All timing thresholds (long-press, double-press window, flick durations) configurable via `config.json`.

## Requirements

- Homebridge ≥ 1.0
- Node.js ≥ 18
- iPort SM Buttons hardware from April 2016 or later (firmware V6+). The earlier "DDM" hardware is not supported (see iPort's spec).
- Each bezel reachable on TCP port `10001` and assigned a stable IP (DHCP reservation or static).

## Installation

### Via Homebridge UI

Search for `homebridge-iport-bezel` in the Plugins tab (once published to npm).

### From source (git)

```bash
git clone git@github.com:dmitry-kutergin/iport-homebridge.git
cd iport-homebridge
npm install
npm run build
sudo npm install -g .
```

Then restart Homebridge.

## Configuration

Add a platform entry to `~/.homebridge/config.json` (or use the Homebridge UI's JSON editor):

```json
{
  "platforms": [
    {
      "platform": "IportBezelPlatform",
      "name": "iPort Bezels",
      "longPressMs": 500,
      "doublePressMs": 500,
      "singleFlickMs": 300,
      "longFlickMs": 1000,
      "doubleFlickGapMs": 150,
      "flickColor": "#00FF00",
      "ips": [
        {
          "ip": "192.168.1.50",
          "accessoryName": "Lobby Bezel",
          "buttonCount": 10
        },
        {
          "ip": "192.168.1.51",
          "accessoryName": "Office Bezel",
          "buttonCount": 10
        },
        {
          "ip": "192.168.1.52",
          "accessoryName": "Living Room Bezel",
          "buttonCount": 6
        }
      ]
    }
  ]
}
```

### Field reference

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `platform` | yes | — | Must be `"IportBezelPlatform"`. |
| `name` | yes | — | Display name for the platform (free text). |
| `ips` | yes | — | Array of bezel definitions. |
| `ips[].ip` | yes | — | LAN IP of the bezel. The bezel must be reachable on TCP `10001`. |
| `ips[].accessoryName` | no | `"iPort Bezel"` | HomeKit accessory name. |
| `ips[].buttonCount` | no | `10` | Number of buttons on the bezel (6 or 10). |
| `longPressMs` | no | `500` | Press-and-hold duration before a `LONG_PRESS` fires. |
| `doublePressMs` | no | `500` | Time window after release in which a second tap is registered as a `DOUBLE_PRESS`. Also sets the `SINGLE_PRESS` emit delay (we must wait this long after release to know it's not a double). |
| `singleFlickMs` | no | `300` | Duration of a single green flick (used for `SINGLE_PRESS` confirmation and each half of the double flick). |
| `longFlickMs` | no | `1000` | Duration of the green flick used for `LONG_PRESS` confirmation. |
| `doubleFlickGapMs` | no | `150` | Restore-color gap between the two flicks of a `DOUBLE_PRESS` confirmation. |
| `flickColor` | no | `"#00FF00"` | Hex color used for the press-confirmation flick. `#` is optional. If the LED is currently close to this color, the flick uses the bitwise inverse of the current color so it stays visible. |

Hosting multiple bezels under a [Child Bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges) is recommended so a single misbehaving bezel can't slow the main bridge.

## Gesture timing

Per-button state machine (all thresholds configurable — see [Field reference](#field-reference)):

- **Single press** — quick tap. Emitted `doublePressMs` (default 500 ms) **after release** (the wait is required so a possible second tap can be detected as a double press).
- **Double press** — second tap arrives within `doublePressMs` after release of the first.
- **Long press** — fires the moment the hold crosses `longPressMs` (default 500 ms), then ignores everything else until you let go. One hold = one event.

The bezel auto-repeats `state:1` every ~300 ms while held; the plugin coalesces those into a single gesture.

## LED control and visual feedback

Each bezel exposes a **Lightbulb** service with On / Brightness / Hue / Saturation. The plugin converts HomeKit HSB → RGB and sends `led=#RRGGBB` to the bezel. The bezel's LED command sets all LEDs to the same color, so it is one Lightbulb per bezel rather than per button.

**At startup** the bezel is queried (`led=?`) and its reply seeds both the LedController and the HomeKit Lightbulb characteristics — so the slider in Home accurately reflects what the LEDs are physically showing on first connect. After that, HomeKit is the source of truth: subsequent bezel replies (keep-alive echoes) are ignored so they can't drift the slider. If the bezel doesn't reply within 5 s of connect, the plugin falls back to pushing HomeKit's cached value to the bezel.

Every recognized button press briefly flicks the LEDs to the **`flickColor`** (default `#00FF00` — green) so the user gets immediate confirmation:

| Gesture | LED flick pattern |
| --- | --- |
| Single press | `singleFlickMs` flickColor → restore. |
| Double press | `singleFlickMs` flickColor → `doubleFlickGapMs` restore → `singleFlickMs` flickColor → restore. |
| Long press | `longFlickMs` flickColor → restore. |

If the LED is currently close to the configured `flickColor` (RGB-channel-sum distance < 100), the flick uses the **bitwise inverse** of the current color so the confirmation stays visible — e.g. with the default green flick color, pure green LEDs flick to pure magenta.

## HomeKit usage

`StatelessProgrammableSwitch` services have no visible on/off state in the Home app's main UI. To use them:

1. In Home, **+ → Add Automation → An Accessory Is Controlled**.
2. Pick the bezel accessory; each numbered button shows up.
3. Choose **Single Press / Double Press / Long Press** and configure the action.

Buttons can also be renamed individually — open the accessory's settings, tap a button, edit its name. The plugin stores user-set names via the HomeKit `ConfiguredName` characteristic and they persist across restarts.

## Development

```bash
npm install
npm run build       # compile TypeScript → dist/
```

To iterate against a real Homebridge install, link the package:

```bash
npm link
# in your homebridge install dir:
npm link homebridge-iport-bezel
```

The full TypeScript source is in `src/index.ts`.

## Logging

By default the plugin emits info-level lines for one-time events (`Registering new iPort Bezel:`, `connection restored`, `seeded from bezel: led=#…`) and warnings for connection loss. Per-press logs (`button N single/double/long pressed`) and per-step LED flick traces are emitted at **debug** level so the Homebridge log stays quiet during normal use. To see them temporarily, start Homebridge with `-D` or enable debug in the UI.

## Troubleshooting

**New services don't appear in the Home app.** iOS / macOS HomeKit aggressively caches the HAP database for paired bridges. After adding a new service (e.g., the Lightbulb), the client may not refetch the schema on its own.

1. Force-quit Home (swipe up on iPhone, ⌘Q on Mac) and reopen.
2. If still missing, unpair the child bridge in the Homebridge UI (`Status → Bridge → Child Bridges → ⋮ → Unpair Bridge`) and re-add it from the QR code.

**Repeated "MaxListenersExceededWarning: shutdown listeners".** Not from this plugin — usually `homebridge-camera-ui` registers many shutdown listeners. Harmless; restart with `NODE_OPTIONS=--trace-warnings` to confirm the source.

## Protocol reference

This plugin implements the JSON-over-TCP protocol described in *iPort SM Buttons API and Driver Development, Rev. G*:

- Bezel listens on **TCP 10001** as the server; the plugin is the client.
- On connect, the bezel sends a "connection" report (with `keys[]`) listing the current state of all buttons.
- On press/release, the bezel sends an "event" report with `events[]` containing `{label: "key N", state: "0"|"1"}`.
- The bezel auto-repeats `state:1` events every ~300 ms while a button is held — the plugin coalesces these into a single gesture.
- LED commands are framed as `<CR>led=…<CR>` (leading **and** trailing carriage return, per spec page 16). The plugin sends:
  - `led=#RRGGBB` to set color (used for HomeKit changes and for the flick animation).
  - `led=?` to query — the bezel replies in **9-digit decimal RGB** form (e.g. `led=000255000` for pure green). The parser handles both hex and decimal reply formats.

## License

MIT — see [LICENSE](./LICENSE).
