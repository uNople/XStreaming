/**
 * Motion aiming for a DualSense: the controller's movement steers the aim the
 * way Tears of the Kingdom's bow does, through the right stick.
 *
 * This is the same logic as the desktop bridge (trigger-bridge, MotionAim), kept
 * in step with it by a replay test. It has no React Native imports.
 *
 * Measured on TotK (Ryubing, DualSense, 2026-11-25): the camera turns 1.2 degrees
 * for each degree the controller is panned about the real-world vertical, like a
 * steering wheel laid flat, whatever position the controller is held in; it tilts
 * with the far edge; tilting sideways does nothing; all angle for angle.
 *
 * Departures from TotK, asked for by the user: up and down matches left and
 * right; slow movements can have a lower sensitivity than fast ones; motion is
 * ignored while the right stick is in use; and after a flick the hand coming
 * back is ignored.
 *
 * The console only takes stick input, which sets a turning speed. So the angle
 * still owed is kept as a balance and paid out through the stick, using the
 * game's measured response to find the stick position for a wanted speed.
 */

export type MotionTuning = {
  motion: number;
  motion_slow: number;
  motion_vertical: number;
  motion_speed: number;
  motion_vertical_game: number;
  motion_curve: number;
  motion_floor: number;
  motion_table: number;
  motion_smooth: number;
  motion_catch_up: number;
  motion_aim_only: number;
  motion_stick_pause: number;
  motion_flick_return: number;
  motion_flick_speed: number;
  motion_vehicle: number;
  motion_invert_x: number;
  motion_invert_y: number;
};

export type MotionTuningKey = keyof MotionTuning;

/**
 * A highest value of 1 is an on/off switch; `choices` names the options of a
 * choice; everything else is a slider, a percentage unless `unit` says otherwise.
 * The defaults are the values the user settled on at the desktop.
 */
export const MOTION_TUNING: {
  key: MotionTuningKey;
  label: string;
  min: number;
  max: number;
  def: number;
  unit?: string;
  choices?: string[];
}[] = [
  {
    key: 'motion',
    label: 'Sensitivity for fast movements (100% matches Zelda, 0 is off)',
    min: 0,
    max: 500,
    def: 185,
  },
  {
    key: 'motion_slow',
    label: 'Sensitivity for slow, careful movements',
    min: 10,
    max: 300,
    def: 60,
  },
  {
    key: 'motion_vertical',
    label: 'Up and down, share of left and right',
    min: 0,
    max: 200,
    def: 100,
  },
  {
    key: 'motion_speed',
    label: "Game's turn speed at full stick",
    min: 30,
    max: 720,
    def: 168,
    unit: '°/s',
  },
  {
    key: 'motion_vertical_game',
    label: "Game's up and down speed while aiming, share of sideways",
    min: 20,
    max: 150,
    def: 50,
  },
  {
    key: 'motion_curve',
    label: "Game's stick curve (100% is a straight line)",
    min: 100,
    max: 400,
    def: 108,
  },
  {
    key: 'motion_floor',
    label: "Game's stick dead zone",
    min: 0,
    max: 40,
    def: 23,
  },
  {
    key: 'motion_table',
    label:
      'Use the measured stick response (the sliders above are then the fallback)',
    min: 0,
    max: 1,
    def: 1,
  },
  {
    key: 'motion_smooth',
    label: 'Smoothness (more is steadier, less is quicker)',
    min: 0,
    max: 150,
    def: 60,
    unit: ' ms',
  },
  {
    key: 'motion_catch_up',
    label: 'Catch-up after a fast movement',
    min: 0,
    max: 300,
    def: 112,
    unit: ' ms',
  },
  {
    key: 'motion_aim_only',
    label: 'Only while aiming (L2 held)',
    min: 0,
    max: 1,
    def: 1,
  },
  {
    key: 'motion_stick_pause',
    label: 'Pause while the right stick is used',
    min: 0,
    max: 1,
    def: 1,
  },
  {
    key: 'motion_flick_return',
    label: 'After a flick, ignore the hand coming back',
    min: 0,
    max: 1,
    def: 1,
  },
  {
    key: 'motion_flick_speed',
    label: 'How fast a movement counts as a flick',
    min: 60,
    max: 400,
    def: 150,
    unit: '°/s',
  },
  {
    key: 'motion_vehicle',
    label: 'In a vehicle',
    min: 0,
    max: 2,
    def: 1,
    choices: [
      'Same rule as on foot',
      'Motion aiming off',
      'Motion aiming always on',
    ],
  },
  {
    key: 'motion_invert_x',
    label: 'Invert left and right',
    min: 0,
    max: 1,
    def: 0,
  },
  {key: 'motion_invert_y', label: 'Invert up and down', min: 0, max: 1, def: 0},
];

/** Saved values, with anything missing or out of range replaced by its default. */
export const normaliseMotionTuning = (
  saved?: Partial<Record<MotionTuningKey, unknown>> | null,
): MotionTuning => {
  const values = {} as MotionTuning;
  for (const {key, min, max, def} of MOTION_TUNING) {
    const value = Math.trunc(Number(saved?.[key]));
    values[key] =
      saved?.[key] == null || Number.isNaN(value)
        ? def
        : Math.max(min, Math.min(max, value));
  }
  return values;
};

/**
 * GTA 6's aim response on Xbox, measured through the stream on 2026-11-25:
 * (stick position, degrees a second), from the last position where the camera
 * stood still. The game is the same whichever device plays it.
 */
export const GTA6_RESPONSE: [number, number][] = [
  [0.205, 0.0],
  [0.2175, 0.13],
  [0.2238, 0.223],
  [0.2269, 0.582],
  [0.23, 0.709],
  [0.3, 9.515],
  [0.4, 35.511],
  [0.5, 50.044],
  [0.62, 71.14],
  [0.75, 97.356],
  [0.88, 135.337],
  [1.0, 147.204],
];

const PAN_GAIN = 1.2; // camera degrees per controller degree, left and right (TotK)
const QUIET = 0.25; // deg/s; slower than this is treated as sensor noise
const RESPONSE = 0.02; // seconds over which owed movement is paid out
const START = 0.004; // share of full turn speed at which paying out begins (no measured table)
const STOP = 0.001; // share at which it pauses again
const SETTLE_LEAST = 0.025; // seconds; the least catch-up that still lets a movement through
const SETTLE_SLACK = 0.4; // degrees that may always be owed, so slow movements still add up
const REST_AFTER = 0.03; // seconds of stillness, on top of the catch-up, before nothing is owed
const GRAVITY_BLEND = 0.4; // seconds for the accelerometer to correct the "up" estimate
const STILL_BAND = 1.0; // deg/s the rate may wander and still count as resting
const STILL_LIMIT = 4.0; // deg/s; a resting reading further from zero is real motion
const STILL_SECONDS = 0.75; // resting time before the gyro's zero offset is updated
const AIM_HELD = 40; // L2 position (0-255) that counts as aiming
const HOLD_RATE = 0.06; // seconds a reading stays valid while waiting for the next one
const FLICK_LEAST = 3.0; // degrees a fast movement must cover to count as a flick
const FLICK_RETURN_TIME = 0.8; // seconds after a flick within which the hand coming back is ignored
const FLICK_SETTLED = 0.2; // seconds of a near-still hand after which it is taken to have stayed put
const FLICK_SPARE = 1.15; // the return may be this much longer than the flick and still be ignored
const STICK_USED = 0.15; // right-stick deflection that counts as using it
const STICK_AFTER = 0.12; // seconds after letting the stick go before motion counts again
const SLOW_BELOW = 8.0; // deg/s of hand movement that gets the slow sensitivity
const FAST_ABOVE = 60.0; // deg/s that gets the fast sensitivity; in between it blends
const SMOOTH_FAST = 0.35; // share of the smoothing that quick movements still get

type Vec3 = [number, number, number];
type Vec2 = [number, number];
type FlickReturn = {
  direction: Vec2;
  left: number;
  deadline: number;
  calm: number;
};

const dot = (a: number[], b: number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class MotionAim {
  bias: Vec3 = [0, 0, 0];
  up: Vec3 | null = null; // which way is up, in the controller's own axes
  trace: [number, number, number, number] = [0, 0, 0, 0];

  private owed: Vec2 = [0, 0]; // degrees of camera movement not yet sent
  private moving = 0;
  private wanted: Vec2 = [0, 0]; // degrees of movement waiting in the smoothing buffer
  private time = 0; // the smoothing time in force, seconds
  private paidAt: number | null = null;
  private on = false; // whether motion currently drives the aim
  private lastSpeed = 0; // the turn speed last asked for...
  private lastDirection: Vec2 = [0, 0]; // ...and its direction
  private flick: Vec2 | null = null; // the fast movement under way: pan and pitch covered so far
  private back: FlickReturn | null = null;
  private rate: Vec2 = [0, 0]; // the turn the hand was last seen asking for, degrees a second
  private rateAt = -1e9;
  private pace = 0; // how fast the hand is moving, lightly smoothed
  private stickSeen = -1e9;
  private quiet = 0;
  private paying = false;
  private last: number | null = null;
  private still: {
    start: number;
    first: Vec3;
    sums: Vec3;
    count: number;
  } | null = null;
  private limit = SETTLE_SLACK;

  private gain = 0;
  private gainSlow = 0;
  private stickPause = true;
  private flickRule = true;
  private flickSpeed = 150;
  private smooth = 0.06;
  private vertical = 1;
  private verticalGame = 1;
  private fullSpeed = 150;
  private curve = 1;
  private floor = 0;
  private useTable = true;
  private settle = 0.1;
  private aimOnly = false;
  private vehicleRule = 0;
  private signX = -1;
  private signY = -1;
  private measured: [number, number][] | null = GTA6_RESPONSE;
  private table: [number, number][] | null = null;
  private slowest = 0;

  constructor(values?: MotionTuning) {
    this.configure(values || normaliseMotionTuning());
  }

  configure(values: MotionTuning) {
    this.gain = (PAN_GAIN * values.motion) / 100;
    this.gainSlow = (PAN_GAIN * values.motion_slow) / 100;
    this.stickPause = !!values.motion_stick_pause;
    this.flickRule = !!values.motion_flick_return;
    this.flickSpeed = values.motion_flick_speed;
    this.smooth = values.motion_smooth / 1000;
    this.vertical = values.motion_vertical / 100;
    this.verticalGame = values.motion_vertical_game / 100;
    this.fullSpeed = values.motion_speed; // deg/s the game turns at full stick
    this.curve = values.motion_curve / 100; // game speed = stick ** curve
    this.floor = values.motion_floor / 100;
    this.useTable = !!values.motion_table;
    this.applyResponse();
    this.settle = Math.max(SETTLE_LEAST, values.motion_catch_up / 1000);
    this.aimOnly = !!values.motion_aim_only;
    this.vehicleRule = values.motion_vehicle; // 0 as on foot, 1 off, 2 always on
    this.signX = values.motion_invert_x ? 1 : -1;
    this.signY = values.motion_invert_y ? 1 : -1;
  }

  /** The game's measured response: [stick, degrees a second] pairs, rising, from a still position. */
  setResponse(table: [number, number][] | null) {
    this.measured = table;
    this.applyResponse();
  }

  private applyResponse() {
    this.table = this.useTable ? this.measured : null;
    if (this.table) {
      this.fullSpeed = this.table[this.table.length - 1][1]; // the measurement replaces the turn-speed slider
      this.slowest = this.table[1][1]; // the slowest turn the game was seen to make
    }
  }

  /** The stick position that makes the game turn at `speed` degrees a second. */
  private stickFor(speed: number) {
    const table = this.table;
    if (!table) {
      return (
        this.floor +
        (1 - this.floor) * Math.pow(speed / this.fullSpeed, 1 / this.curve)
      );
    }
    for (let i = 1; i < table.length; i++) {
      const [lowStick, lowSpeed] = table[i - 1];
      const [highStick, highSpeed] = table[i];
      if (speed <= highSpeed) {
        return (
          lowStick +
          ((highStick - lowStick) * (speed - lowSpeed)) / (highSpeed - lowSpeed)
        );
      }
    }
    return table[table.length - 1][0];
  }

  /**
   * Drop the hand's journey back after a flick. The part of the movement that
   * runs against the flick is left out until the hand has come back about as far
   * as it went, has settled where it is, or time is up.
   */
  private withoutReturn(
    panIn: number,
    pitchIn: number,
    step: number,
    now: number,
  ): Vec2 {
    let pan = panIn;
    let pitch = pitchIn;
    let speed = Math.hypot(pan, pitch);
    const back = this.back;
    if (back) {
      const against = -(pan * back.direction[0] + pitch * back.direction[1]); // speed of the hand coming back
      back.calm = speed < 3 ? back.calm + step : 0;
      if (now > back.deadline || back.calm > FLICK_SETTLED) {
        this.back = null;
      } else if (against > 0) {
        pan += back.direction[0] * against;
        pitch += back.direction[1] * against;
        back.left -= against * step;
        if (back.left <= 0) {
          this.back = null;
        }
        speed = Math.hypot(pan, pitch);
      }
    }
    const flick = this.flick;
    if (!flick) {
      if (speed > this.flickSpeed) {
        this.flick = [pan * step, pitch * step];
      }
    } else {
      const forward = pan * flick[0] + pitch * flick[1];
      if (speed < 0.4 * this.flickSpeed || forward < 0) {
        // the throw is over
        const covered = Math.hypot(flick[0], flick[1]);
        if (covered >= FLICK_LEAST) {
          this.back = {
            direction: [flick[0] / covered, flick[1] / covered],
            left: covered * FLICK_SPARE,
            deadline: now + FLICK_RETURN_TIME,
            calm: 0,
          };
        }
        this.flick = null;
        if (forward < 0 && this.back) {
          // Already on the way back: this reading belongs to the return.
          return this.withoutReturn(pan, pitch, step, now);
        }
      } else {
        flick[0] += pan * step;
        flick[1] += pitch * step;
      }
    }
    return [pan, pitch];
  }

  /** While the controller rests, take its average reading as the gyro's zero. */
  private calibrate(rates: Vec3, now: number) {
    const still = this.still;
    if (still) {
      if (
        rates.every(
          (rate, axis) => Math.abs(rate - still.first[axis]) < STILL_BAND,
        )
      ) {
        for (let axis = 0; axis < 3; axis++) {
          still.sums[axis] += rates[axis];
        }
        still.count += 1;
        if (now - still.start >= STILL_SECONDS) {
          this.bias = [
            still.sums[0] / still.count,
            still.sums[1] / still.count,
            still.sums[2] / still.count,
          ];
          this.still = null;
        }
        return;
      }
    }
    const steady = rates.every(rate => Math.abs(rate) < STILL_LIMIT);
    this.still = steady
      ? {start: now, first: [...rates], sums: [...rates], count: 1}
      : null;
  }

  /** Follow "up" with the gyro and pull it gently toward the accelerometer. */
  private trackUp(turn: Vec3, accel: Vec3, step: number) {
    const size = Math.sqrt(dot(accel, accel));
    if (!this.up) {
      this.up =
        size > 0.5
          ? [accel[0] / size, accel[1] / size, accel[2] / size]
          : [0, 1, 0];
      return;
    }
    const w = turn.map(value => (value * Math.PI) / 180);
    const u = this.up;
    let up: Vec3 = [
      u[0] + (u[1] * w[2] - u[2] * w[1]) * step,
      u[1] + (u[2] * w[0] - u[0] * w[2]) * step,
      u[2] + (u[0] * w[1] - u[1] * w[0]) * step,
    ];
    if (size > 0.85 && size < 1.15) {
      // close to 1 g: the controller is not being shaken
      const blend = Math.min(1, step / GRAVITY_BLEND);
      up = [
        up[0] + (accel[0] / size - up[0]) * blend,
        up[1] + (accel[1] / size - up[1]) * blend,
        up[2] + (accel[2] / size - up[2]) * blend,
      ];
    }
    const length = Math.sqrt(dot(up, up)) || 1;
    this.up = [up[0] / length, up[1] / length, up[2] / length];
  }

  /**
   * One reading. `rates` are the gyro's degrees a second about the controller's
   * x (left to right), y (up through its face) and z (toward the player) axes;
   * `accel` is the accelerometer in g, or a ready "up" direction; `l2` is 0-255;
   * `stick` is the right stick, -1..1 each. Returns the stick push (x, y).
   */
  sample(
    rates: Vec3,
    accel: Vec3,
    l2: number,
    stick: Vec2,
    now: number,
    vehicle = false,
  ): Vec2 {
    this.read(rates, accel, l2, stick, now, vehicle);
    return this.advance(now);
  }

  private read(
    rates: Vec3,
    accel: Vec3,
    l2: number,
    stick: Vec2,
    now: number,
    vehicle: boolean,
  ) {
    const held = l2 >= AIM_HELD;
    const aiming = held && !vehicle; // in a vehicle L2 is the brake
    let active: boolean;
    if (vehicle && this.vehicleRule === 1) {
      active = false;
    } else if (vehicle && this.vehicleRule === 2) {
      active = true;
    } else {
      active = held || !this.aimOnly;
    }
    if (!(held && this.aimOnly)) {
      this.calibrate(rates, now);
    }
    const step =
      this.last === null
        ? 0.004
        : Math.max(0.0005, Math.min(0.05, now - this.last));
    this.last = now;
    const turn: Vec3 = [
      rates[0] - this.bias[0],
      rates[1] - this.bias[1],
      rates[2] - this.bias[2],
    ];
    this.trackUp(turn, accel, step);

    if (this.stickPause && Math.hypot(stick[0], stick[1]) > STICK_USED) {
      this.stickSeen = now;
    }
    if (now - this.stickSeen < STICK_AFTER) {
      active = false; // the stick has the aim; motion waits until it is let go
    }
    this.trace = [0, 0, 0, 0];
    this.on = !!(this.gain && active);
    if (!this.on) {
      this.flick = null;
      this.back = null;
      this.rate = [0, 0];
      this.wanted = [0, 0];
      this.owed = [0, 0]; // movement counts from the moment aiming starts
      this.paying = false;
      return;
    }

    // "right" is the controller's left-to-right axis levelled out.
    const up = this.up as Vec3;
    const lean = up[0];
    let right: Vec3 = [1 - lean * up[0], -lean * up[1], -lean * up[2]];
    const length = Math.sqrt(dot(right, right));
    let moving = 0;
    let hand: Vec2 = [0, 0];
    if (length >= 0.3) {
      right = [right[0] / length, right[1] / length, right[2] / length];
      const still = Math.sqrt(dot(turn, turn)) <= QUIET;
      let panLeft = still ? 0 : dot(turn, up); // anticlockwise seen from above
      let pitchUp = still ? 0 : dot(turn, right); // far edge rising
      if (this.flickRule) {
        [panLeft, pitchUp] = this.withoutReturn(panLeft, pitchUp, step, now);
      } else {
        this.flick = null;
        this.back = null;
      }
      const speed = Math.hypot(panLeft, pitchUp);
      hand = [panLeft, pitchUp];
      // Sensitivity follows the pace of the hand: low for careful movements,
      // high for quick ones, blending in between.
      this.pace += (speed - this.pace) * Math.min(1, step / 0.03);
      const quick = Math.max(
        0,
        Math.min(1, (this.pace - SLOW_BELOW) / (FAST_ABOVE - SLOW_BELOW)),
      );
      const gain = this.gainSlow + (this.gain - this.gainSlow) * quick;
      const vertical = this.vertical / (aiming ? this.verticalGame : 1);
      const wanted: Vec2 = [
        this.signX * panLeft * gain,
        this.signY * pitchUp * gain * vertical,
      ];
      // The movement waits in a buffer that advance() drains at the smoothing
      // rate, so every degree that goes in comes out exactly once.
      this.time = this.smooth * (1 - (1 - SMOOTH_FAST) * quick);
      // The hand is taken to keep turning at this rate until the next reading says otherwise.
      this.rate = wanted;
      this.rateAt = now;
      const asked = Math.hypot(wanted[0], wanted[1]);
      // Camera speed the hand is asking for right now, as far as the game can follow it.
      moving = Math.min(asked, this.fullSpeed);
      this.quiet = asked > 0.05 ? 0 : this.quiet + step;
    } else {
      this.rate = [0, 0]; // held on its side: directions are ambiguous
      this.quiet += step;
    }
    // Follows a rise at once and falls away over the catch-up time, so what a
    // quick movement left owed can still arrive after the hand has stopped.
    const horizon = this.settle + this.smooth; // smoothing delays the turn, so allow for it too
    this.moving = Math.max(
      moving,
      this.moving * (1 - Math.min(1, step / horizon)),
    );
    // The hand has come to rest, and the smoothed turn has run out: so does the aim.
    if (this.quiet > this.settle + REST_AFTER) {
      this.owed = [0, 0];
    }
    // Settle with the hand: only the catch-up time's worth of the current movement may be owed.
    this.limit = SETTLE_SLACK + this.moving * horizon;
    if (length >= 0.3) {
      this.trace = [hand[0], hand[1], this.owed[0], this.owed[1]];
    }
  }

  /**
   * Move the output on to `now`: drain the smoothing buffer and pay out what is
   * owed. Run this on a steady clock as well as with every reading: readings
   * arrive unevenly, and the aim must keep gliding through the gaps.
   */
  advance(now: number): Vec2 {
    const step =
      this.paidAt === null ? 0 : Math.max(0, Math.min(0.05, now - this.paidAt));
    this.paidAt = now;
    if (!this.on) {
      this.lastSpeed = 0;
      this.lastDirection = [0, 0];
      return [0, 0];
    }
    if (step > 0) {
      if (now - this.rateAt > HOLD_RATE) {
        this.rate = [0, 0]; // readings have stopped: do not keep turning blind
      }
      const share = this.time <= 0 ? 1 : 1 - Math.exp(-step / this.time);
      for (let axis = 0; axis < 2; axis++) {
        this.wanted[axis] += this.rate[axis] * step;
        const released = this.wanted[axis] * share;
        this.wanted[axis] -= released;
        this.owed[axis] += released;
      }
      const size = Math.hypot(this.owed[0], this.owed[1]);
      if (size > this.limit) {
        this.owed = [
          (this.owed[0] * this.limit) / size,
          (this.owed[1] * this.limit) / size,
        ];
      }
    }
    return this.pay(step);
  }

  private pay(step: number): Vec2 {
    // First settle what the previous push has delivered: the game has been turning
    // at that speed for the whole of the time since. It can never count for more
    // than was owed in its direction, so the balance cannot tip the other way.
    if (this.lastSpeed && step > 0) {
      const along =
        this.owed[0] * this.lastDirection[0] +
        this.owed[1] * this.lastDirection[1];
      const taken = Math.min(this.lastSpeed * step, Math.max(0, along));
      this.owed = [
        this.owed[0] - this.lastDirection[0] * taken,
        this.owed[1] - this.lastDirection[1] * taken,
      ];
    }
    const size = Math.hypot(this.owed[0], this.owed[1]);
    let speed = size / RESPONSE; // wanted turn speed, degrees a second
    // With the game's real response known, even its slowest turn can be asked for
    // steadily, so fine aiming moves smoothly instead of in pulses.
    const start = this.table ? this.slowest * 0.6 : START * this.fullSpeed;
    const stop = this.table ? this.slowest * 0.2 : STOP * this.fullSpeed;
    if (speed < (this.paying ? stop : start)) {
      this.paying = false;
      this.lastSpeed = 0;
      this.lastDirection = [0, 0];
      return [0, 0];
    }
    this.paying = true;
    speed = Math.min(speed, this.fullSpeed);
    const direction: Vec2 = [this.owed[0] / size, this.owed[1] / size];
    this.lastSpeed = speed;
    this.lastDirection = direction;
    const push = this.stickFor(speed);
    return [direction[0] * push, direction[1] * push];
  }
}
