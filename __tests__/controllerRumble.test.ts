import {expect, test} from '@jest/globals';
import type {Settings} from '../src/store/settingStore';
import {controllerRumble, rumbleStrength} from '../src/utils/controllerRumble';

const settings = {
  vibration: true,
  rumble_intensity: 3,
  rumble_strength: null,
} as Settings;
const packet = {
  weakMagnitude: 0.4,
  strongMagnitude: 0.6,
  leftTrigger: 0.25,
  rightTrigger: 0.5,
};

test('mutes both handle motors and keeps the trigger channels', () => {
  expect(controllerRumble({...settings, vibration: false}, packet)).toEqual([
    0, 0, 16384, 32768,
  ]);
});

test('scales and clips handle rumble while keeping the selected strength', () => {
  expect(controllerRumble({...settings, rumble_strength: 50}, packet)).toEqual([
    13107, 19661, 16384, 32768,
  ]);
  expect(controllerRumble({...settings, rumble_strength: 250}, packet)).toEqual(
    [65535, 65535, 16384, 32768],
  );
  expect(
    rumbleStrength({...settings, vibration: false, rumble_strength: 50}),
  ).toBe(50);
});

test('preserves legacy strength settings until a continuous value is chosen', () => {
  const strong = {...settings, rumble_intensity: 4};
  expect(controllerRumble(strong, packet)).toEqual([
    39321, 65535, 16384, 32768,
  ]);
  expect(rumbleStrength(strong)).toBe(175);
});
