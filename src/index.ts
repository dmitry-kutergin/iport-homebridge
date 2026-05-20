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

// ─── Color helpers ───────────────────────────────────────────────────────────

function hexToHsb(hex: string): { h: number; s: number; bri: number } {
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if      (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : (d / max) * 100;
  const bri = max * 100;
  return { h, s, bri };
}

function hsbToHex(h: number, s: number, b: number): string {
  const sn = Math.max(0, Math.min(100, s)) / 100;
  const bn = Math.max(0, Math.min(100, b)) / 100;
  const hh = ((h % 360) + 360) % 360;
  const c = bn * sn;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = bn - c;
  let r = 0, g = 0, bl = 0;
  if      (hh <  60) { r = c; g = x; bl = 0; }
  else if (hh < 120) { r = x; g = c; bl = 0; }
  else if (hh < 180) { r = 0; g = c; bl = x; }
  else if (hh < 240) { r = 0; g = x; bl = c; }
  else if (hh < 300) { r = x; g = 0; bl = c; }
  else               { r = c; g = 0; bl = x; }
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0').toUpperCase();
  return to(r) + to(g) + to(bl);
}

function isGreenish(hex: string): boolean {
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return g > 128 && g > r && g > b;
}

function invertHex(hex: string): string {
  const r = 255 - parseInt(hex.substring(0, 2), 16);
  const g = 255 - parseInt(hex.substring(2, 4), 16);
  const b = 255 - parseInt(hex.substring(4, 6), 16);
  return [r, g, b].map(n => n.toString(16).padStart(2, '0').toUpperCase()).join('');
}

const FLICK_GREEN = '00FF00';

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
  onLed?   : (hex: string) => void;
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
    // Per spec page 16, LED commands are framed as <CR>led=...<CR>.
    // Without the leading CR the bezel processes the first command of a
    // connection but ignores back-to-back commands (the second one is appended
    // to the trailing-CR state of the first).
    this.socket.write(`\rled=#${hex}\r`);
    this.lastSentLed = hex;
  }

  queryLed(): void {
    if (!this.alive || !this.socket) return;
    this.socket.write('\rled=?\r');
  }

  lastSentLed: string | null = null;

  // ── internals ─────────────────────────────────────────────────────────────
  // Per SM Buttons API spec (Rev. G, page 13): reports have no `type` field.
  // A connection report carries `keys[]`; an event report carries `events[]`.
  // Each entry is {label: "key N", state: "0"|"1"}.
  // Non-JSON lines are LED responses (either "led=#RRGGBB" hex or
  // "led=RRRGGGBBB" 9-digit decimal per spec page 16).
  private parse(line: string): void {
    let r: RawReport;
    try { r = JSON.parse(line); }
    catch {
      // Per spec page 16, the bezel uses two LED formats:
      //   hex     :  led=#1791EF
      //   decimal :  led=023145239     (9-digit, 3+3+3 zero-padded RGB)
      // Match the hex form (with required '#') OR the 9-digit decimal form
      // explicitly. The previous regex matched 6 hex chars first and would
      // mis-parse "led=000255000" as hex 0x000255 instead of decimal R=0/G=255/B=0.
      const m = /led\s*=\s*(?:#([0-9A-Fa-f]{6})|(\d{9}))/.exec(line);
      if (m) {
        let hex: string;
        if (m[1]) {
          hex = m[1].toUpperCase();
        } else {
          const p = m[2];
          const r2 = parseInt(p.substring(0, 3), 10);
          const g2 = parseInt(p.substring(3, 6), 10);
          const b2 = parseInt(p.substring(6, 9), 10);
          hex = [r2, g2, b2].map(n => Math.min(255, n).toString(16).padStart(2, '0')).join('').toUpperCase();
        }
        this.onLed?.(hex);
      }
      return;
    }

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

// ─── LED Controller ──────────────────────────────────────────────────────────

interface Timings {
  longPressMs: number;
  doublePressMs: number;
  singleFlickMs: number;
  longFlickMs: number;
  doubleFlickGapMs: number;
}

const DEFAULT_TIMINGS: Timings = {
  longPressMs:      500,
  doublePressMs:    500,
  singleFlickMs:    300,
  longFlickMs:      1000,
  doubleFlickGapMs: 150,
};

type FlickPattern = 'single' | 'double' | 'long';

class LedController {
  private h   = 0;
  private s   = 0;
  private bri = 100;
  private on  = true;

  private applyTimer: any = null;
  private flickTimer: any = null;
  private flicking        = false;

  constructor(
    private readonly tcp: TcpClient,
    private readonly timings: Timings,
    private readonly log?: { debug: (msg: string) => void },
  ) {}

  setHue       (v: number): void  { this.h   = v;          this.schedule(); }
  setSaturation(v: number): void  { this.s   = v;          this.schedule(); }
  setBrightness(v: number): void  { this.bri = v;          this.schedule(); }
  setOn        (v: boolean): void { this.on  = !!v;        this.schedule(); }

  // Push the current HSB/on state to the bezel right away (no debounce).
  applyImmediate(): void {
    if (this.applyTimer) { clearTimeout(this.applyTimer); this.applyTimer = null; }
    if (!this.flicking) this.tcp.writeLed(this.userHex());
  }

  // Sync internal state from a hex value the bezel reported (no write back).
  // Returns the HSB so callers can mirror to HomeKit characteristics.
  applyFromBezel(hex: string): { on: boolean; h: number; s: number; bri: number } {
    if (this.applyTimer) { clearTimeout(this.applyTimer); this.applyTimer = null; }
    const on  = hex.toUpperCase() !== '000000';
    const hsb = hexToHsb(hex);
    this.on  = on;
    this.h   = hsb.h;
    this.s   = hsb.s;
    this.bri = on ? hsb.bri : this.bri; // keep last bri when "off" so toggling back restores it
    return { on, h: hsb.h, s: hsb.s, bri: hsb.bri };
  }

  flick(pattern: FlickPattern): void {
    if (this.flickTimer) { clearTimeout(this.flickTimer); this.flickTimer = null; }
    const orig   = this.userHex();
    const accent = isGreenish(orig) ? invertHex(orig) : FLICK_GREEN;
    const single = this.timings.singleFlickMs;
    const long   = this.timings.longFlickMs;
    const gap    = this.timings.doubleFlickGapMs;
    let steps: Array<{ hex: string; ms: number }>;
    switch (pattern) {
      case 'single': steps = [{ hex: accent, ms: single }, { hex: orig, ms: 0 }]; break;
      case 'double': steps = [
        { hex: accent, ms: single }, { hex: orig, ms: gap },
        { hex: accent, ms: single }, { hex: orig, ms: 0 },
      ]; break;
      case 'long':   steps = [{ hex: accent, ms: long }, { hex: orig, ms: 0 }]; break;
    }
    this.flicking = true;
    this.runFlick(steps);
  }

  private schedule(): void {
    if (this.applyTimer) clearTimeout(this.applyTimer);
    this.applyTimer = setTimeout(() => { this.applyTimer = null; this.apply(); }, 50);
    this.applyTimer.unref?.();
  }

  private apply(): void {
    if (!this.flicking) this.tcp.writeLed(this.userHex());
  }

  private userHex(): string {
    return this.on ? hsbToHex(this.h, this.s, this.bri) : '000000';
  }

  private runFlick(steps: Array<{ hex: string; ms: number }>): void {
    if (steps.length === 0) {
      this.flicking = false;
      this.flickTimer = null;
      this.tcp.writeLed(this.userHex());
      this.log?.debug(`flick done → restore ${this.userHex()}`);
      return;
    }
    const [head, ...tail] = steps;
    this.tcp.writeLed(head.hex);
    this.log?.debug(`flick step → ${head.hex} (next in ${head.ms}ms, ${tail.length} step(s) remaining)`);
    if (tail.length === 0) {
      this.flicking = false;
      this.flickTimer = null;
      return;
    }
    this.flickTimer = setTimeout(() => this.runFlick(tail), head.ms);
    this.flickTimer.unref?.();
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
  led: LedController;
}

class IportBezelPlatform {

  private readonly cached = new Map<string, PlatformAccessory>();
  // Runtime state kept off `accessory.context` so Homebridge's JSON
  // serialization of the cache doesn't choke on TCP sockets / Timeout objects.
  private readonly runtime = new Map<string, BezelRuntime>();

  private readonly timings: Timings;

  constructor(private readonly log: Logging, private readonly config: PlatformConfig, private readonly api: API) {
    const cfg = config as Record<string, unknown>;
    const num = (key: keyof Timings) => {
      const v = cfg[key];
      const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN;
      return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TIMINGS[key];
    };
    this.timings = {
      longPressMs:      num('longPressMs'),
      doublePressMs:    num('doublePressMs'),
      singleFlickMs:    num('singleFlickMs'),
      longFlickMs:      num('longFlickMs'),
      doubleFlickGapMs: num('doubleFlickGapMs'),
    };
    this.log.debug(`Timings: ${JSON.stringify(this.timings)}`);

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

    // ── Lightbulb (LED color) ───────────────────────────────────────────────
    const bulbName = `${name} LEDs`;
    let bulb: any = acc.getService(hap.Service.Lightbulb);
    let bulbJustCreated = false;
    if (!bulb) {
      bulb = acc.addService(hap.Service.Lightbulb, bulbName, 'leds');
      bulbJustCreated = true;
    } else {
      bulb.setCharacteristic(hap.Characteristic.Name, bulbName);
    }
    bulb.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
    if (!bulb.testCharacteristic(hap.Characteristic.ConfiguredName)
        || !bulb.getCharacteristic(hap.Characteristic.ConfiguredName).value) {
      bulb.setCharacteristic(hap.Characteristic.ConfiguredName, bulbName);
    }
    // Ensure HSB characteristics exist on the Lightbulb service.
    for (const ch of [hap.Characteristic.Brightness, hap.Characteristic.Hue, hap.Characteristic.Saturation]) {
      if (!bulb.testCharacteristic(ch)) bulb.addCharacteristic(ch);
    }

    // Initialize sensible defaults exactly once per accessory. The flag lives
    // in acc.context so it survives Homebridge restarts. Without this, freshly
    // added (or previously bezel-mirrored, now-corrupted) Lightbulbs default
    // to off / bri=0 / random hue.
    if (bulbJustCreated || !acc.context.lightbulbInitialized) {
      this.log.info(`[${ip}] initializing Lightbulb to white at 100% on`);
      bulb.setCharacteristic(hap.Characteristic.On, true);
      bulb.setCharacteristic(hap.Characteristic.Brightness, 100);
      bulb.setCharacteristic(hap.Characteristic.Hue, 0);
      bulb.setCharacteristic(hap.Characteristic.Saturation, 0);
      acc.context.lightbulbInitialized = true;
    }

    const tcp = new TcpClient(ip, () => { /* reconnection handled internally */ });
    const led = new LedController(tcp, this.timings, { debug: (m) => this.log.debug(`[${ip}] ${m}`) });
    const btnState: ButtonState[] = Array.from({ length: count }, () => ({ held: false, consumed: false, singleTimer: null, longTimer: null }));
    const rt: BezelRuntime = { services, btnState, tcp, led };
    this.runtime.set(acc.UUID, rt);

    // On first connect, the bezel is the source of truth: we send led=? and
    // mirror the reply into both LedController and HomeKit. Subsequent led=
    // responses (periodic keep-alives, echoes from our own writes) are ignored
    // so they don't drift the slider.
    let seededFromBezel = false;
    tcp.onLed = (hex) => {
      if (seededFromBezel) {
        this.log.debug(`[${ip}] bezel led=#${hex} (post-seed, ignored)`);
        return;
      }
      seededFromBezel = true;
      const { on, h, s, bri } = led.applyFromBezel(hex);
      this.log.info(`[${ip}] seeded from bezel: led=#${hex} (on=${on}, h=${h.toFixed(0)}, s=${s.toFixed(0)}, bri=${bri.toFixed(0)})`);
      bulb.updateCharacteristic(hap.Characteristic.On, on);
      if (on) {
        bulb.updateCharacteristic(hap.Characteristic.Hue, h);
        bulb.updateCharacteristic(hap.Characteristic.Saturation, s);
        bulb.updateCharacteristic(hap.Characteristic.Brightness, Math.max(1, Math.round(bri)));
      }
    };

    // Seed LedController provisionally from HomeKit cache. If the bezel
    // responds to our query in time, applyFromBezel will overwrite this.
    const seedOn  = !!bulb.getCharacteristic(hap.Characteristic.On).value;
    const seedHue = Number(bulb.getCharacteristic(hap.Characteristic.Hue).value ?? 0);
    const seedSat = Number(bulb.getCharacteristic(hap.Characteristic.Saturation).value ?? 0);
    const seedBri = Number(bulb.getCharacteristic(hap.Characteristic.Brightness).value ?? 100);
    led.setOn(seedOn);
    led.setHue(seedHue);
    led.setSaturation(seedSat);
    led.setBrightness(seedBri);

    bulb.getCharacteristic(hap.Characteristic.On)
        .onSet((v: any) => led.setOn(!!v));
    bulb.getCharacteristic(hap.Characteristic.Brightness)
        .onSet((v: any) => led.setBrightness(Number(v)));
    bulb.getCharacteristic(hap.Characteristic.Hue)
        .onSet((v: any) => led.setHue(Number(v)));
    bulb.getCharacteristic(hap.Characteristic.Saturation)
        .onSet((v: any) => led.setSaturation(Number(v)));

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
            this.log.debug(`${ip} button ${evt.num} double pressed`);
            btn.updateCharacteristic(PSE, PSE.DOUBLE_PRESS);
            rt.led.flick('double');
          } else {
            // First press of a new gesture — schedule LONG_PRESS at longPressMs.
            st.longTimer = setTimeout(() => {
              st.longTimer = null;
              st.consumed = true;           // ignore auto-repeats and release until next gesture
              this.log.debug(`${ip} button ${evt.num} long pressed`);
              btn.updateCharacteristic(PSE, PSE.LONG_PRESS);
              rt.led.flick('long');
            }, this.timings.longPressMs);
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

          // Short tap — wait doublePressMs for a possible 2nd press before firing SINGLE.
          st.singleTimer = setTimeout(() => {
            st.singleTimer = null;
            this.log.debug(`${ip} button ${evt.num} single pressed`);
            btn.updateCharacteristic(PSE, PSE.SINGLE_PRESS);
            rt.led.flick('single');
          }, this.timings.doublePressMs);
          st.singleTimer.unref?.();
        }
      }
    };

    tcp.onKeys = () => {};
    tcp.onUp   = () => {
      this.log.info(`${ip} connection restored`);
      if (!seededFromBezel) {
        // First connect after Homebridge start — read the bezel.
        tcp.queryLed();
        // Fallback: if no reply in 5s, lock the seed flag and push HomeKit's
        // value so the bezel reflects the cached UI state.
        setTimeout(() => {
          if (!seededFromBezel) {
            seededFromBezel = true;
            this.log.warn(`[${ip}] bezel did not reply to led=?; pushing HomeKit state`);
            rt.led.applyImmediate();
          }
        }, 5000).unref?.();
      } else {
        // Reconnect: push HomeKit's current state in case the bezel rebooted.
        rt.led.applyImmediate();
      }
    };
    tcp.onLost = () => { this.log.warn(`${ip} connection lost`); };

    tcp.connect();

    if (!fresh) this.api.updatePlatformAccessories([acc]);
  }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

export default (api: API): void => {
  api.registerPlatform('homebridge-iport-bezel', 'IportBezelPlatform', IportBezelPlatform);
};
