import {
  DeviceEventEmitter,
  EmitterSubscription,
  NativeEventEmitter,
  NativeModules,
} from 'react-native';
import {SETTINGS_CHANGED_EVENT} from '../store/settingStore';
import {Gta6TriggerDriver} from './gta6Driver';
import {MotionAim, normaliseMotionTuning} from './motionAim';

/**
 * GTA 6 adaptive triggers and motion aiming for a DualSense on iOS and iPadOS.
 *
 * The native GamepadManager module applies trigger effects through the
 * GameController framework (Bluetooth or USB) and reports the controller's
 * motion. Body rumble keeps going through GamepadManager.rumble as before, so
 * the trigger driver's motor values are not used here.
 *
 * Motion aiming needs the "Native" gamepad setting: there this app sends the
 * stick positions to the web player itself, and can add the aim push to them.
 */
let driver: Gta6TriggerDriver | null = null;
let motion: MotionAim | null = null;
let subscriptions: EmitterSubscription[] = [];
let leftTrigger = 0; // 0 to 255
let rightStick: [number, number] = [0, 0];

const seconds = () =>
  (global.performance?.now ? global.performance.now() : Date.now()) / 1000;
const DEGREES = 180 / Math.PI;

/** Starts whichever of the two is switched on. Returns whether the triggers are being driven. */
export const startGta6Triggers = (settings: any): boolean => {
  stopGta6Triggers();
  const {GamepadManager} = NativeModules;
  if (!GamepadManager) {
    return false;
  }
  const events = new NativeEventEmitter(GamepadManager);
  // The native module reports trigger and stick positions whichever gamepad kernel is selected.
  subscriptions.push(
    events.addListener('onController', state => {
      leftTrigger = (Number(state?.leftTrigger) || 0) * 255;
      rightStick = [
        Number(state?.rightStickX) || 0,
        -(Number(state?.rightStickY) || 0),
      ];
      driver?.setTriggers(
        Number(state?.leftTrigger) || 0,
        Number(state?.rightTrigger) || 0,
      );
    }),
  );

  if (settings?.gta6_triggers && GamepadManager.setAdaptiveTriggers) {
    driver = new Gta6TriggerDriver((left, right) =>
      GamepadManager.setAdaptiveTriggers(
        left.mode,
        left.params,
        right.mode,
        right.params,
      ),
    );
    driver.start();
  }

  if (GamepadManager.setMotionReporting) {
    const aim = new MotionAim(
      normaliseMotionTuning(settings?.gta6_trigger_tuning),
    );
    motion = aim;
    subscriptions.push(
      // The framework gives rotation in radians a second about its own axes: x is the
      // controller's left-to-right axis, z its vertical one and y points away from the
      // player. MotionAim wants x, then up through the face, then toward the player.
      // Acceleration is in g, and reads "up" while the controller rests.
      events.addListener('onMotion', reading => {
        aim.sample(
          [reading.rx * DEGREES, reading.rz * DEGREES, -reading.ry * DEGREES],
          [reading.ax, reading.ay, reading.az],
          leftTrigger,
          rightStick,
          seconds(),
          driver?.vehicle ?? false,
        );
      }),
      DeviceEventEmitter.addListener(SETTINGS_CHANGED_EVENT, changed =>
        aim.configure(normaliseMotionTuning(changed?.gta6_trigger_tuning)),
      ),
    );
    GamepadManager.setMotionReporting(true);
  }
  return !!driver;
};

export const stopGta6Triggers = () => {
  subscriptions.forEach(subscription => subscription.remove());
  subscriptions = [];
  if (motion) {
    NativeModules.GamepadManager?.setMotionReporting?.(false);
    motion = null;
  }
  if (driver) {
    driver.stop();
    driver = null;
  }
};

/** Hands a rumble packet to the trigger profile; the caller still plays the body rumble itself. */
export const gta6Rumble = (rumbleData: any, durationMs: number) => {
  driver?.onRumble(
    rumbleData?.weakMagnitude,
    rumbleData?.strongMagnitude,
    durationMs,
  );
};

/**
 * The motion-aim push on the right stick for this moment, x then y (down is
 * positive), each -1 to 1. Call it on the same steady clock that sends the
 * gamepad state, so the aim keeps gliding between motion readings.
 */
export const gta6AimPush = (): [number, number] =>
  motion ? motion.advance(seconds()) : [0, 0];
