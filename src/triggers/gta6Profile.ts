/**
 * GTA 6 adaptive-trigger profile for a DualSense.
 *
 * GTA 6 on Xbox sends body rumble only, so the triggers are derived from it:
 * a trigger break on R2 and a recoil kick for each shot on foot, pedal
 * resistance and impact jolts in a vehicle.
 *
 * This is the same logic and the same defaults as the desktop bridge
 * (trigger-bridge, Gta6Profile), so the triggers feel alike on every device.
 * It has no React Native imports, so it runs unchanged on Android and iOS and
 * under plain Node for the replay test.
 *
 * Measured on the Xbox Series stream, 2026-11-25:
 * - a gunshot is a burst on both motors (weak up to 0.98, strong up to 0.78)
 *   that fades over about 0.3 s; nothing arrives on the trigger channels;
 * - a vehicle sends a low hum on the weak motor alone, 10 to 26 packets a
 *   second, with gaps of a second or two on smooth road; on foot the same kind
 *   of packet usually arrives 1 to 3 times a second.
 *
 * Vehicle mode starts on a sustained hum. It ends after three quiet seconds
 * with both triggers released, or when two aimed shots land within four
 * seconds (stepping out of a car straight into a fight).
 */

/** A DualSense trigger effect: the mode byte and its parameter bytes. */
export type TriggerEffect = {mode: number; params: number[]};

export type Gta6Tuning = {
  break_strength: number;
  break_point: number;
  kick: number;
  aim: number;
  throttle: number;
  brake: number;
  jolt: number;
};

export type Gta6TuningKey = keyof Gta6Tuning;

/** Strengths run 0 (off) to 8 (stiffest); kick and jolt are percentages. */
export const GTA6_TUNING: {
  key: Gta6TuningKey;
  group: 'foot' | 'vehicle';
  label: string;
  min: number;
  max: number;
  def: number;
}[] = [
  {
    key: 'break_strength',
    group: 'foot',
    label: 'Trigger break strength (R2)',
    min: 0,
    max: 8,
    def: 6,
  },
  {
    key: 'break_point',
    group: 'foot',
    label: 'Trigger break point (R2)',
    min: 3,
    max: 8,
    def: 5,
  },
  {
    key: 'kick',
    group: 'foot',
    label: 'Recoil kick (R2)',
    min: 0,
    max: 100,
    def: 100,
  },
  {
    key: 'aim',
    group: 'foot',
    label: 'Aim resistance (L2)',
    min: 0,
    max: 8,
    def: 2,
  },
  {
    key: 'throttle',
    group: 'vehicle',
    label: 'Throttle resistance (R2)',
    min: 0,
    max: 8,
    def: 2,
  },
  {
    key: 'brake',
    group: 'vehicle',
    label: 'Brake resistance (L2)',
    min: 0,
    max: 8,
    def: 5,
  },
  {
    key: 'jolt',
    group: 'vehicle',
    label: 'Impact jolt (both)',
    min: 0,
    max: 100,
    def: 100,
  },
];

/** Saved values, with anything missing or out of range replaced by its default. */
export const normaliseTuning = (
  saved?: Partial<Record<Gta6TuningKey, unknown>> | null,
): Gta6Tuning => {
  const values = {} as Gta6Tuning;
  for (const {key, min, max, def} of GTA6_TUNING) {
    const value = Math.trunc(Number(saved?.[key]));
    values[key] =
      saved?.[key] == null || Number.isNaN(value)
        ? def
        : Math.max(min, Math.min(max, value));
  }
  return values;
};

const byte = (value: number) =>
  Math.max(0, Math.min(255, roundHalfEven(value)));

export const TRIGGER_OFF: TriggerEffect = {mode: 0x05, params: []};

export const vibration = (
  frequency: number,
  amplitude: number,
): TriggerEffect => ({
  mode: 0x06,
  params: [byte(frequency), byte(amplitude)],
});

/** Resistance per travel zone: ten strengths, each 0 (free) to 8 (stiffest). */
export const feedback = (zones: number[]): TriggerEffect => {
  let active = 0;
  // Three bits per zone make 30 bits, so keep the low and high halves apart.
  let low = 0;
  let high = 0;
  zones.slice(0, 10).forEach((raw, index) => {
    const value = Math.max(0, Math.min(8, Math.trunc(raw)));
    if (value) {
      active |= 1 << index;
      if (index < 5) {
        low |= (value - 1) << (3 * index);
      } else {
        high |= (value - 1) << (3 * (index - 5));
      }
    }
  });
  const strength = low + high * 32768;
  return {
    mode: 0x21,
    params: [
      active & 0xff,
      active >> 8,
      strength % 256,
      Math.floor(strength / 256) % 256,
      Math.floor(strength / 65536) % 256,
      Math.floor(strength / 16777216) % 256,
      0,
      0,
      0,
      0,
    ],
  };
};

/** Resistance from zone `start` that gives way at zone `end`, like a trigger break. */
export const weapon = (
  start: number,
  end: number,
  strength: number,
): TriggerEffect => {
  const from = Math.max(2, Math.min(7, start));
  const to = Math.max(from + 1, Math.min(8, end));
  const zones = (1 << from) | (1 << to);
  return {
    mode: 0x25,
    params: [zones & 0xff, zones >> 8, Math.max(1, Math.min(8, strength)) - 1],
  };
};

const level = (value: unknown) => {
  const number = Number(value);
  return Number.isNaN(number) ? 0 : Math.max(0, Math.min(1, number));
};

const pull = (strength: number, ease: number): TriggerEffect => {
  if (!strength) {
    return TRIGGER_OFF;
  }
  const zones = [0, 0];
  for (let step = 0; step < 8; step++) {
    zones.push(step < ease ? Math.max(1, Math.floor(strength / 2)) : strength);
  }
  return feedback(zones);
};

export class Gta6Profile {
  static HUM_MAX = 0.2; // weak-motor level that still counts as engine or road hum
  static HUM_AFTER_BURST = 0.5; // seconds after a burst during which its tail is ignored
  static ENTER_COUNT = 22; // hum packets within ENTER_WINDOW that mean "in a vehicle"
  static ENTER_WINDOW = 2.0;
  static EXIT_COUNT = 7; // fewer hum packets than this within EXIT_WINDOW counts as quiet
  static EXIT_WINDOW = 3.0; // also how long both triggers must have been released
  static HELD = 30; // trigger position (0-255) that counts as held
  static AIMED_SHOTS = 2; // aimed shots within AIMED_WINDOW that end vehicle mode
  static AIMED_WINDOW = 4.0;
  static SHOT_AFTER_PRESS = 0.45; // seconds a shot's rumble can trail the R2 press over the stream
  static BURST_GAP = 0.12; // seconds without a burst packet before the next one starts a new burst
  static BURST_RISE = 0.3; // jump in level that starts a new burst inside the previous one's tail
  static BURST_HOLD = 0.09; // seconds a burst packet keeps an impact jolt alive
  static KICK_SECONDS = 0.13; // length of the recoil kick on R2
  static KICK_MIN = 0.5; // burst level needed for a recoil kick

  footR2 = TRIGGER_OFF;
  footL2 = TRIGGER_OFF;
  vehicleR2 = TRIGGER_OFF;
  vehicleL2 = TRIGGER_OFF;
  kickStart = -1e9;
  vehicle = false;

  private kickScale = 1;
  private joltScale = 1;
  private hum: number[] = [];
  private burstSeen = -1e9;
  private burstLevel = 0;
  private previousWeak = 0;
  private kickLevel = 0;
  private l2 = 0;
  private r2 = 0;
  private heldSeen = -1e9;
  private r2Press = -1e9;
  private aimedShots: number[] = [];

  constructor(tuning?: Gta6Tuning) {
    this.configure(tuning || normaliseTuning());
  }

  configure(values: Gta6Tuning) {
    const {break_strength: strength, break_point: point, brake} = values;
    // Trigger break for firing: resistance that gives way at `point`.
    this.footR2 = strength ? weapon(point - 3, point, strength) : TRIGGER_OFF;
    // A light, even pull for aiming, eased in over the first zones.
    this.footL2 = pull(values.aim, 2);
    this.vehicleR2 = pull(values.throttle, 3);
    // The brake firms up with travel, from 40% of its strength to all of it.
    if (brake) {
      const zones = [0, 0];
      for (let step = 0; step < 8; step++) {
        zones.push(
          Math.max(1, roundHalfEven(brake * (0.4 + (0.6 * step) / 7))),
        );
      }
      this.vehicleL2 = feedback(zones);
    } else {
      this.vehicleL2 = TRIGGER_OFF;
    }
    this.kickScale = values.kick / 100;
    this.joltScale = values.jolt / 100;
  }

  /** `now` is in seconds; `weak` and `strong` are the packet's motor levels, 0 to 1. */
  onPacket(weakMagnitude: unknown, strongMagnitude: unknown, now: number) {
    const weak = level(weakMagnitude);
    const strong = level(strongMagnitude);
    if (strong > 0) {
      const fresh =
        now - this.burstSeen > Gta6Profile.BURST_GAP ||
        weak - this.previousWeak >= Gta6Profile.BURST_RISE;
      if (fresh && weak >= Gta6Profile.KICK_MIN) {
        this.kickStart = now;
        this.kickLevel = weak;
        const firing =
          this.r2 > 60 || now - this.r2Press < Gta6Profile.SHOT_AFTER_PRESS;
        if (this.l2 > 100 && firing) {
          this.aimedShots.push(now);
          if (this.aimedShots.length > Gta6Profile.AIMED_SHOTS) {
            this.aimedShots.shift();
          }
        }
      } else if (now - this.kickStart < Gta6Profile.KICK_SECONDS) {
        this.kickLevel = Math.max(this.kickLevel, weak);
      }
      this.burstSeen = now;
      this.burstLevel = weak;
    } else if (
      weak > 0 &&
      weak <= Gta6Profile.HUM_MAX &&
      now - this.burstSeen > Gta6Profile.HUM_AFTER_BURST
    ) {
      this.hum.push(now);
    }
    this.previousWeak = weak;
  }

  private updateVehicle(now: number) {
    while (this.hum.length && this.hum[0] < now - Gta6Profile.EXIT_WINDOW) {
      this.hum.shift();
    }
    if (this.vehicle) {
      const quiet =
        this.hum.length < Gta6Profile.EXIT_COUNT &&
        now - this.heldSeen > Gta6Profile.EXIT_WINDOW;
      const fight =
        this.aimedShots.length === Gta6Profile.AIMED_SHOTS &&
        now - this.aimedShots[0] < Gta6Profile.AIMED_WINDOW;
      if (quiet || fight) {
        this.vehicle = false;
        this.hum = [];
      }
    } else {
      const since = now - Gta6Profile.ENTER_WINDOW;
      let recent = 0;
      for (const stamp of this.hum) {
        if (stamp >= since) {
          recent++;
        }
      }
      if (recent >= Gta6Profile.ENTER_COUNT) {
        this.vehicle = true;
      }
    }
  }

  state(now: number): 'vehicle' | 'foot' {
    this.updateVehicle(now);
    return this.vehicle ? 'vehicle' : 'foot';
  }

  /** `l2` and `r2` are trigger positions 0 to 255. Returns [left, right]. */
  effects(now: number, l2: number, r2: number): [TriggerEffect, TriggerEffect] {
    if (r2 > 100 && this.r2 <= 100) {
      this.r2Press = now;
    }
    if (l2 > Gta6Profile.HELD || r2 > Gta6Profile.HELD) {
      this.heldSeen = now;
    }
    this.l2 = l2;
    this.r2 = r2;
    this.updateVehicle(now);
    if (this.vehicle) {
      if (this.joltScale && now - this.burstSeen < Gta6Profile.BURST_HOLD) {
        // collision, kerb, hard landing
        const jolt = vibration(
          40,
          (90 + 165 * this.burstLevel) * this.joltScale,
        );
        return [jolt, jolt];
      }
      return [this.vehicleL2, this.vehicleR2];
    }
    if (this.kickScale && now - this.kickStart < Gta6Profile.KICK_SECONDS) {
      // recoil follows the shot's rumble
      return [
        this.footL2,
        vibration(30, (110 + 145 * this.kickLevel) * this.kickScale),
      ];
    }
    return [this.footL2, this.footR2];
  }
}

/** Python's round(): ties go to the even neighbour, which the desktop bridge relies on. */
function roundHalfEven(value: number) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) {
    return floor;
  }
  if (diff > 0.5) {
    return floor + 1;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

export const sameEffect = (a: TriggerEffect, b: TriggerEffect) =>
  a.mode === b.mode &&
  a.params.length === b.params.length &&
  a.params.every((value, index) => value === b.params[index]);
