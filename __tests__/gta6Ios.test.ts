import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import {DeviceEventEmitter, NativeModules} from 'react-native';
import {getSettings} from '../src/store/settingStore';
import {startGta6Triggers, stopGta6Triggers} from '../src/triggers/gta6Ios';
import {MotionAim} from '../src/triggers/motionAim';

jest.mock('../src/store/settingStore', () => ({
  getSettings: () => ({gta6_triggers: false}),
  SETTINGS_CHANGED_EVENT: 'SETTINGS_CHANGED',
}));

const setMotionReporting = jest.fn();
const originalManager = NativeModules.GamepadManager;

beforeEach(() => {
  NativeModules.GamepadManager = {
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    setMotionReporting,
  };
  setMotionReporting.mockClear();
});

afterEach(() => {
  stopGta6Triggers();
  NativeModules.GamepadManager = originalManager;
});

const still = {
  rx: 0,
  ry: 0,
  rz: 0,
  ax: 0,
  ay: -1,
  az: 0,
  leftTrigger: 1,
  rightStickX: 0,
  rightStickY: 0,
};

type Vector3 = [number, number, number];
type SendAim = (push: [number, number]) => void;

describe('iOS motion aiming', () => {
  const turns: [string, typeof still, Vector3, Vector3][] = [
    ['flat', {...still, rz: 1}, [0, 1, 0], [0, 1, 0]],
    ['upright', {...still, ry: 1, ay: 0, az: 1}, [0, 0, -1], [0, 0, -1]],
    ['pitch', {...still, rx: 0.5}, [0.5, 0, 0], [0, 1, 0]],
  ];
  test.each(turns)(
    'matches the desktop input for a %s turn',
    (_, reading, radians, up) => {
      const sendAim = jest.fn<SendAim>();
      const reference = new MotionAim();
      const [x, y, z] = radians;
      const toDegrees = 180 / Math.PI;

      expect(startGta6Triggers(getSettings(), sendAim)).toBe(true);
      for (let tick = 0; tick < 40; tick++) {
        const time = 100 + tick * 0.004;
        if (tick % 3 === 0) {
          DeviceEventEmitter.emit('onMotion', {...reading, time});
          reference.sample(
            [x * toDegrees, y * toDegrees, z * toDegrees],
            up,
            255,
            [0, 0],
            time,
          );
        }
        DeviceEventEmitter.emit('onMotionTick', time);
        expect(sendAim).toHaveBeenLastCalledWith(reference.advance(time));
      }
      expect(sendAim).toHaveBeenCalledTimes(40);
      expect(sendAim.mock.calls[39][0].some(axis => axis < 0)).toBe(true);
    },
  );

  test('uses L2 and the right stick of the motion sample', () => {
    const sendAim = jest.fn<SendAim>();
    startGta6Triggers(getSettings(), sendAim);

    const pan = {...still, rz: 1};
    DeviceEventEmitter.emit('onController', {leftTrigger: 0, rightStickX: 1});
    DeviceEventEmitter.emit('onMotion', {...pan, time: 100});
    DeviceEventEmitter.emit('onMotionTick', 100.008);
    expect(sendAim.mock.calls[0][0][0]).toBeLessThan(0);

    DeviceEventEmitter.emit('onMotion', {
      ...pan,
      time: 100.012,
      rightStickX: 0.5,
    });
    DeviceEventEmitter.emit('onMotionTick', 100.016);
    expect(sendAim).toHaveBeenLastCalledWith([0, 0]);

    DeviceEventEmitter.emit('onMotion', {...pan, time: 100.14});
    DeviceEventEmitter.emit('onMotionTick', 100.148);
    expect(sendAim.mock.calls[2][0][0]).toBeLessThan(0);

    DeviceEventEmitter.emit('onMotion', {
      ...pan,
      time: 100.152,
      leftTrigger: 0,
    });
    DeviceEventEmitter.emit('onMotionTick', 100.156);
    expect(sendAim).toHaveBeenLastCalledWith([0, 0]);
  });

  test('stops the native clock and removes its listeners when the stream ends', () => {
    const sendAim = jest.fn<SendAim>();
    startGta6Triggers(getSettings(), sendAim);
    expect(setMotionReporting).toHaveBeenLastCalledWith(true);

    stopGta6Triggers();
    expect(setMotionReporting).toHaveBeenLastCalledWith(false);
    DeviceEventEmitter.emit('onMotionTick', 100);
    expect(sendAim).not.toHaveBeenCalled();

    expect(startGta6Triggers(getSettings())).toBe(false);
    expect(setMotionReporting).toHaveBeenCalledTimes(2);
  });
});
