// ─── Protocol types ──────────────────────────────────────────────────────────

interface KeyInfo {
  num: number;
  state: number; // 0 = released, 1 = pressed
}

interface RawKey { label: string; state: string }
interface RawReport {
  deviceid?: string;
  model?: string;
  macaddr?: string;
  version?: string;
  uptime?: string;
  eventtime?: string;
  keys?: RawKey[];
  events?: RawKey[];
}

function parseKey(k: RawKey): KeyInfo {
  const m = /(\d+)/.exec(k.label || '');
  return {
    num: m ? parseInt(m[1], 10) : 0,
    state: k.state === '1' ? 1 : 0,
  };
}

// ─── TCP Client ──────────────────────────────────────────────────────────────

const TCP_PORT = 10001;
const DELIMITER = '\r\n';
const RECONNECT_MS = 5000;
const HEALTH_MS   = 60_000;

class TcpClient {
  private socket: ReturnType<typeof import('net').connect> | null = null;
  private buf   = '';
  private tmrReconn: ReturnType<typeof setTimeout> | null = null;
  private tmrHealth: ReturnType<typeof setInterval> | null = null;
  private alive     = false;

  onKeys?  : (keys: KeyInfo[]) => void;
  onEvent? : (events: KeyInfo[]) => void;
  onLost?  : () => void;
  onUp?    : () => void;

  constructor(
    private host: string,
    private onReconn: () => void,
  ) {}

  connect(): void {
    this.tmrReconn = null;
    const net = require('net');
    this.socket = net.connect(TCP_PORT, this.host, () => {
      this.alive = true;
      this.buf = '';
      this.startHealth();
      this.onUp?.();
    });

    this.socket.on('data', (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf(DELIMITER)) !== -1) {
        const line = this.buf.substring(0, i).trim();
        this.buf = this.buf.substring(i + DELIMITER.length);
        if (line) this.parse(line);
      }
    });

    this.socket.on('error',  () => this.crash('sock err'));
    this.socket.on('close',  () => this.crash('closed'));
  }

  destroy(): void {
    this.killHealth();
    if (this.tmrReconn) { clearTimeout(this.tmrReconn); this.tmrReconn = null; }
    if (this.socket)     { this.socket.destroy();       this.socket = null; }
    this.alive = false;
  }

  writeLed(hex: string): void {
    if (!this.alive || !this.socket) return;
    this.socket.write(`led=#${hex}\r`);
  }

  queryLed(): void {
    if (!this.alive || !this.socket) return;
    this.socket.write('led=?\r');
  }

  // ── internals ─────────────────────────────────────────────────────────────
  // Per SM Buttons API spec (Rev. G, page 13): reports have no `type` field.
  // A connection report carries `keys[]`; an event report carries `events[]`.
  // Each entry is {label: "key N", state: "0"|"1"}.
  private parse(line: string): void {
    let r: RawReport;
    try { r = JSON.parse(line); }
    catch { return; } // non-JSON (LED acks like "led=#ABCDEF")

    if (r.events && r.events.length) {
      this.onEvent?.(r.events.map(parseKey));
    } else if (r.keys && r.keys.length) {
      this.onKeys?.(r.keys.map(parseKey));
    }
  }

  private crash(reason: string): void {
    this.alive = false;
    this.killHealth();
    if (this.socket) { this.socket.destroy(); this.socket = null; }
    this.onLost?.();
    this.tmrReconn = setTimeout(() => {
      this.onReconn();
      this.connect();
    }, RECONNECT_MS);
    this.tmrReconn.unref?.();
  }

  private startHealth(): void {
    this.killHealth();
    this.tmrHealth = setInterval(() => {
      if (!this.alive) this.crash('health timeout');
      else this.queryLed();
    }, HEALTH_MS);
    this.tmrHealth.unref?.();
  }

  private killHealth(): void {
    if (this.tmrHealth) { clearInterval(this.tmrHealth); this.tmrHealth = null; }
  }
}

// ─── Platform ────────────────────────────────────────────────────────────────

import { PlatformConfig, API, Logging, PlatformAccessory } from 'homebridge';

const PLUGIN_NAME   = 'homebridge-iport-bezel';
const PLATFORM_NAME = 'IportBezelPlatform';

interface IpConfig { ip: string; accessoryName?: string; buttonCount?: number }

interface ButtonState {
  held: boolean;            // bezel currently reports the button as pressed
  consumed: boolean;        // gesture already emitted (LONG or DOUBLE) — ignore upcoming release
  singleTimer: any | null;  // pending SINGLE_PRESS emit (cleared if 2nd press arrives)
  longTimer: any | null;    // pending LONG_PRESS emit (cleared on early release)
}

interface BezelRuntime {
  services: any[];
  btnState: ButtonState[];
  tcp: TcpClient;
}

const LONG_PRESS_MS   = 500;  // press-and-hold ≥ this duration → LONG_PRESS
const DOUBLE_PRESS_MS = 500;  // window after release to receive a 2nd press → DOUBLE_PRESS

class IportBezelPlatform {

  private readonly cached = new Map<string, PlatformAccessory>();
  // Runtime state kept off `accessory.context` so Homebridge's JSON
  // serialization of the cache doesn't choke on TCP sockets / Timeout objects.
  private readonly runtime = new Map<string, BezelRuntime>();

  constructor(private readonly log: Logging, private readonly config: PlatformConfig, private readonly api: API) {
    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  configureAccessory(acc: PlatformAccessory): void {
    this.cached.set(acc.UUID, acc);
  }

  private discoverDevices(): void {
    const ips = (this.config as Record<string, unknown>).ips as IpConfig[] || [];
    const seen = new Set<string>();

    for (const ipCfg of ips) {
      if (!ipCfg.ip) {
        this.log.warn('Skipping iPort config entry with no ip');
        continue;
      }
      const uuid = this.api.hap.uuid.generate(`iport-bezel-${ipCfg.ip}`);
      seen.add(uuid);

      const existing = this.cached.get(uuid);
      if (existing) {
        this.log.info(`Restoring cached iPort Bezel: ${existing.displayName} (${ipCfg.ip})`);
        this.configureBezel(existing, ipCfg, false);
      } else {
        const name = ipCfg.accessoryName || 'iPort Bezel';
        this.log.info(`Registering new iPort Bezel: ${name} (${ipCfg.ip})`);
        const acc = new this.api.platformAccessory(name, uuid);
        this.configureBezel(acc, ipCfg, true);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      }
    }

    // Remove cached accessories that are no longer in config.
    for (const [uuid, acc] of this.cached) {
      if (!seen.has(uuid)) {
        this.log.info(`Removing stale iPort Bezel from cache: ${acc.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      }
    }
  }

  // ── wire up services + TCP for one accessory ────────────────────────────
  private configureBezel(acc: PlatformAccessory, cfg: IpConfig, fresh: boolean): void {
    const hap = this.api.hap;
    const ip   = cfg.ip;
    const name = cfg.accessoryName || acc.displayName || 'iPort Bezel';
    const count = cfg.buttonCount || 10;

    // Only plain-serializable values may live in acc.context — Homebridge
    // JSON-stringifies it for cachedAccessories.
    acc.context.ip = ip;
    acc.context.buttonCount = count;

    // Tear down any previous runtime for this UUID (re-discovery).
    const prev = this.runtime.get(acc.UUID);
    if (prev) prev.tcp.destroy();

    // ServiceLabel makes the Home app present sub-services as numbered buttons
    // (canonical HomeKit pattern for multi-button accessories).
    let labelSvc: any = acc.getService(hap.Service.ServiceLabel);
    if (!labelSvc) labelSvc = acc.addService(hap.Service.ServiceLabel);
    labelSvc.setCharacteristic(
      hap.Characteristic.ServiceLabelNamespace,
      hap.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS,
    );

    const services: any[] = [];
    for (let i = 1; i <= count; i++) {
      const subtype = `btn${i}`;
      const label = `${name} - Btn ${i}`;
      let svc: any = acc.getServiceById(hap.Service.StatelessProgrammableSwitch, subtype);
      if (!svc) {
        svc = acc.addService(hap.Service.StatelessProgrammableSwitch, label, subtype);
      } else {
        svc.setCharacteristic(hap.Characteristic.Name, label);
      }

      // Numbered button index in the Home app.
      svc.setCharacteristic(hap.Characteristic.ServiceLabelIndex, i);

      // ConfiguredName lets the user rename each button individually in Home.
      // Declare it optional first to silence the "not in optional section" warning.
      svc.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
      if (!svc.testCharacteristic(hap.Characteristic.ConfiguredName)
          || !svc.getCharacteristic(hap.Characteristic.ConfiguredName).value) {
        svc.setCharacteristic(hap.Characteristic.ConfiguredName, label);
      }

      services.push(svc);
    }

    // Drop any leftover button services beyond `count` from previous configs.
    const keep = new Set(services);
    for (const svc of acc.services.slice()) {
      if (svc.UUID === hap.Service.StatelessProgrammableSwitch.UUID && !keep.has(svc)) {
        acc.removeService(svc);
      }
    }

    const tcp = new TcpClient(ip, () => { /* reconnection handled internally */ });
    const btnState: ButtonState[] = Array.from({ length: count }, () => ({ held: false, consumed: false, singleTimer: null, longTimer: null }));
    const rt: BezelRuntime = { services, btnState, tcp };
    this.runtime.set(acc.UUID, rt);

    const PSE = hap.Characteristic.ProgrammableSwitchEvent;

    // The bezel auto-repeats state:1 every ~300ms while held. Gesture rules:
    //   - First state:1: start hold; schedule LONG_PRESS at LONG_PRESS_MS.
    //   - LONG_PRESS fires: mark `consumed`; ignore every subsequent state:1
    //     and the eventual state:0 (no further events for this hold).
    //   - state:1 while still held (auto-repeat): ignore.
    //   - state:0 (release):
    //       • if not consumed: short tap → schedule SINGLE_PRESS at DOUBLE_PRESS_MS.
    //       • if a 2nd state:1 arrives in that window → DOUBLE_PRESS, consume,
    //         and ignore the upcoming release.
    tcp.onEvent = (events) => {
      for (const evt of events) {
        const idx = evt.num - 1;
        const btn = rt.services[idx];
        const st  = rt.btnState[idx];
        if (!btn || !st) {
          this.log.debug(`${ip} event for unknown button ${evt.num}`);
          continue;
        }

        if (evt.state === 1) {
          if (st.held) continue;            // auto-repeat while still pressed — ignore
          st.held = true;

          if (st.singleTimer) {
            // 2nd distinct press within the double-press window → DOUBLE.
            clearTimeout(st.singleTimer);
            st.singleTimer = null;
            st.consumed = true;             // don't fire anything on this press's release
            this.log.info(`${ip} button ${evt.num} double pressed`);
            btn.updateCharacteristic(PSE, PSE.DOUBLE_PRESS);
          } else {
            // First press of a new gesture — schedule LONG_PRESS at LONG_PRESS_MS.
            st.longTimer = setTimeout(() => {
              st.longTimer = null;
              st.consumed = true;           // ignore auto-repeats and release until next gesture
              this.log.info(`${ip} button ${evt.num} long pressed`);
              btn.updateCharacteristic(PSE, PSE.LONG_PRESS);
            }, LONG_PRESS_MS);
            st.longTimer.unref?.();
          }
        } else {
          // Release.
          st.held = false;
          if (st.longTimer) {
            clearTimeout(st.longTimer);
            st.longTimer = null;
          }
          if (st.consumed) {
            st.consumed = false;            // gesture already emitted — reset for next press
            continue;
          }

          // Short tap — wait DOUBLE_PRESS_MS for a possible 2nd press before firing SINGLE.
          st.singleTimer = setTimeout(() => {
            st.singleTimer = null;
            this.log.info(`${ip} button ${evt.num} single pressed`);
            btn.updateCharacteristic(PSE, PSE.SINGLE_PRESS);
          }, DOUBLE_PRESS_MS);
          st.singleTimer.unref?.();
        }
      }
    };

    tcp.onKeys = () => {};
    tcp.onUp   = () => { this.log.info(`${ip} connection restored`); };
    tcp.onLost = () => { this.log.warn(`${ip} connection lost`); };

    tcp.connect();

    if (!fresh) this.api.updatePlatformAccessories([acc]);
  }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

export default (api: API): void => {
  api.registerPlatform('homebridge-iport-bezel', 'IportBezelPlatform', IportBezelPlatform);
};
