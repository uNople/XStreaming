import {
  feedback,
  Gta6Profile,
  normaliseTuning,
  TRIGGER_OFF,
  vibration,
  weapon,
} from '../src/triggers/gta6Profile';

describe('GTA 6 trigger profile', () => {
  test('effect bytes match the DualSense layout', () => {
    expect(feedback([0, 0, 2, 2, 3, 3, 4, 4, 5, 5])).toEqual({
      mode: 0x21,
      params: [0xfc, 0x03, 0x40, 0x22, 0x6d, 0x24, 0, 0, 0, 0],
    });
    expect(weapon(2, 5, 6)).toEqual({mode: 0x25, params: [0b00100100, 0, 5]});
    expect(weapon(7, 8, 8)).toEqual({mode: 0x25, params: [0x80, 0x01, 7]});
    expect(vibration(40, 300)).toEqual({mode: 0x06, params: [40, 255]});
  });

  test('defaults are the desktop values and bad values fall back', () => {
    expect(normaliseTuning()).toEqual({
      break_strength: 6,
      break_point: 5,
      kick: 100,
      aim: 2,
      throttle: 2,
      brake: 5,
      jolt: 100,
    });
    const tuning = normaliseTuning({kick: 250, aim: -3, brake: 'x'} as any);
    expect([tuning.kick, tuning.aim, tuning.brake]).toEqual([100, 0, 5]);
  });

  test('on foot: trigger break, then a recoil kick for a shot', () => {
    const profile = new Gta6Profile();
    expect(profile.effects(1, 255, 0)).toEqual([
      feedback([0, 0, 1, 1, 2, 2, 2, 2, 2, 2]),
      weapon(2, 5, 6),
    ]);
    profile.onPacket(0.98, 0.78, 5);
    expect(profile.effects(5.01, 255, 255)[1]).toEqual(
      vibration(30, 110 + 145 * 0.98),
    );
    expect(profile.effects(5.2, 255, 255)[1]).toEqual(weapon(2, 5, 6));
  });

  test('a sustained hum switches to pedals; quiet with released triggers switches back', () => {
    const profile = new Gta6Profile();
    let now = 10;
    for (let packet = 0; packet < 40; packet++) {
      now += 0.04;
      profile.onPacket(0.04, 0, now);
    }
    expect(profile.state(now)).toBe('vehicle');
    expect(profile.effects(now, 200, 0)).toEqual([
      feedback([0, 0, 2, 2, 3, 3, 4, 4, 5, 5]),
      feedback([0, 0, 1, 1, 1, 2, 2, 2, 2, 2]),
    ]);
    profile.onPacket(0.9, 0.7, now + 0.1); // a collision jolts both triggers
    expect(profile.effects(now + 0.12, 200, 0)).toEqual([
      vibration(40, 90 + 165 * 0.9),
      vibration(40, 90 + 165 * 0.9),
    ]);
    // throttle held on a smooth road: still a vehicle after three quiet seconds
    expect(profile.effects(now + 3.5, 0, 255)[1]).toEqual(
      feedback([0, 0, 1, 1, 1, 2, 2, 2, 2, 2]),
    );
    profile.effects(now + 3.6, 0, 0);
    expect(profile.state(now + 7)).toBe('foot');
  });

  test('every value at zero switches its effect off', () => {
    const profile = new Gta6Profile(
      normaliseTuning({
        break_strength: 0,
        break_point: 3,
        kick: 0,
        aim: 0,
        throttle: 0,
        brake: 0,
        jolt: 0,
      }),
    );
    profile.onPacket(0.98, 0.78, 5);
    expect(profile.effects(5.01, 255, 255)).toEqual([TRIGGER_OFF, TRIGGER_OFF]);
  });
});
