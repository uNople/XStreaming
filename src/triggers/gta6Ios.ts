import {
  EmitterSubscription,
  NativeEventEmitter,
  NativeModules,
} from 'react-native';
import {Gta6TriggerDriver} from './gta6Driver';

/**
 * GTA 6 adaptive triggers for a DualSense on iOS and iPadOS.
 *
 * The native GamepadManager module applies the effects through the
 * GameController framework, which works over Bluetooth and USB. Body rumble
 * keeps going through GamepadManager.rumble as before, so the driver's motor
 * values are not used here.
 */
let driver: Gta6TriggerDriver | null = null;
let positions: EmitterSubscription | null = null;

/** Starts the profile if it is switched on. Returns whether it is now driving the triggers. */
export const startGta6Triggers = (settings: any): boolean => {
  stopGta6Triggers();
  const {GamepadManager} = NativeModules;
  if (!settings?.gta6_triggers || !GamepadManager?.setAdaptiveTriggers) {
    return false;
  }
  driver = new Gta6TriggerDriver((left, right) =>
    GamepadManager.setAdaptiveTriggers(
      left.mode,
      left.params,
      right.mode,
      right.params,
    ),
  );
  // The native module reports trigger positions (0 to 1) whichever gamepad kernel is selected.
  positions = new NativeEventEmitter(GamepadManager).addListener(
    'onController',
    state =>
      driver?.setTriggers(
        Number(state?.leftTrigger) || 0,
        Number(state?.rightTrigger) || 0,
      ),
  );
  driver.start();
  return true;
};

export const stopGta6Triggers = () => {
  positions?.remove();
  positions = null;
  if (driver) {
    driver.stop();
    driver = null;
  }
};

/** Hands a rumble packet to the profile; the caller still plays the body rumble itself. */
export const gta6Rumble = (rumbleData: any, durationMs: number) => {
  driver?.onRumble(
    rumbleData?.weakMagnitude,
    rumbleData?.strongMagnitude,
    durationMs,
  );
};
