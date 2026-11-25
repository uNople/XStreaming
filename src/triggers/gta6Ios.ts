import {
  DeviceEventEmitter,
  EmitterSubscription,
  NativeEventEmitter,
  NativeModules,
} from 'react-native';
import {Settings, SETTINGS_CHANGED_EVENT} from '../store/settingStore';
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
let motionReporting = false;
let subscriptions: EmitterSubscription[] = [];

const DEGREES = 180 / Math.PI;

// Rotate GameController's frame about the pitch axis into the desktop HID frame.
const dualSenseAxes = (
  x: number,
  y: number,
  z: number,
): [number, number, number] => [x, z, -y];

type MotionReading = {
  time: number;
  rx: number;
  ry: number;
  rz: number;
  ax: number;
  ay: number;
  az: number;
  leftTrigger: number;
  rightStickX: number;
  rightStickY: number;
};

/** Starts the trigger profile and reports whether the native clock will send aim updates. */
export const startGta6Triggers = (
  settings: Settings,
  sendAim?: (push: [number, number]) => void,
): boolean => {
  stopGta6Triggers();
  const {GamepadManager} = NativeModules;
  if (!GamepadManager) {
    return false;
  }
  const events = new NativeEventEmitter(GamepadManager);
  if (settings.gta6_triggers && GamepadManager.setAdaptiveTriggers) {
    driver = new Gta6TriggerDriver((left, right) =>
      GamepadManager.setAdaptiveTriggers(
        left.mode,
        left.params,
        right.mode,
        right.params,
      ),
    );
    driver.start();
    subscriptions.push(
      events.addListener('onController', state => {
        driver?.setTriggers(state.leftTrigger, state.rightTrigger);
      }),
    );
  }

  if (sendAim && GamepadManager.setMotionReporting) {
    const aim = new MotionAim(
      normaliseMotionTuning(settings.gta6_trigger_tuning),
    );
    subscriptions.push(
      events.addListener('onMotion', (reading: MotionReading) => {
        // Yaw projects the gyro onto up, so both vectors need the same axes.
        // Negate Apple's acceleration to obtain the desktop's up vector.
        aim.sample(
          dualSenseAxes(
            reading.rx * DEGREES,
            reading.ry * DEGREES,
            reading.rz * DEGREES,
          ),
          dualSenseAxes(-reading.ax, -reading.ay, -reading.az),
          reading.leftTrigger * 255,
          [reading.rightStickX, -reading.rightStickY],
          reading.time,
          driver?.vehicle ?? false,
        );
      }),
      events.addListener('onMotionTick', (time: number) =>
        sendAim(aim.advance(time)),
      ),
      DeviceEventEmitter.addListener(SETTINGS_CHANGED_EVENT, changed =>
        aim.configure(normaliseMotionTuning(changed?.gta6_trigger_tuning)),
      ),
    );
    motionReporting = true;
    GamepadManager.setMotionReporting(true);
  }
  return motionReporting;
};

export const stopGta6Triggers = () => {
  subscriptions.forEach(subscription => subscription.remove());
  subscriptions = [];
  if (motionReporting) {
    NativeModules.GamepadManager?.setMotionReporting?.(false);
    motionReporting = false;
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
