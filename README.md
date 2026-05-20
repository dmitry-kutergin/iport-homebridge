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

| Field | Required | Description |
| --- | --- | --- |
| `platform` | yes | Must be `"IportBezelPlatform"`. |
| `name` | yes | Display name for the platform (free text). |
| `ips` | yes | Array of bezel definitions. |
| `ips[].ip` | yes | LAN IP of the bezel. The bezel must be reachable on TCP `10001`. |
| `ips[].accessoryName` | no | HomeKit accessory name. Default `"iPort Bezel"`. |
| `ips[].buttonCount` | no | Number of buttons on the bezel (6 or 10). Default `10`. |

Hosting multiple bezels under a [Child Bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges) is recommended so a single misbehaving bezel can't slow the main bridge.

## Gesture timing

Per-button state machine:

- **Single press** — quick tap. Emitted **500 ms after release** (the wait is required so a possible second tap can be detected as a double press).
- **Double press** — second tap arrives within 500 ms after release of the first.
- **Long press** — fires the moment the press crosses **500 ms**, then ignores everything else until you let go. One hold = one event.

The bezel auto-repeats `state:1` every ~300 ms while held; the plugin coalesces those into a single gesture.

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

## Protocol reference

This plugin implements the JSON-over-TCP protocol described in *iPort SM Buttons API and Driver Development, Rev. G*:

- Bezel listens on **TCP 10001** as the server; the plugin is the client.
- On connect, the bezel sends a "connection" report (with `keys[]`) listing the current state of all buttons.
- On press/release, the bezel sends an "event" report with `events[]` containing `{label: "key N", state: "0"|"1"}`.
- LED control commands (`led=#RRGGBB`, `led=?`) are sent by the plugin as keep-alive probes; LED color setting from HomeKit is not yet exposed.

## License

MIT — see [LICENSE](./LICENSE).
