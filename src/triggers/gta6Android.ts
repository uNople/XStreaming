import {NativeModules} from 'react-native';
import {Gta6TriggerDriver} from './gta6Driver';

/**
 * GTA 6 adaptive triggers for a DualSense on Android.
 *
 * Android only lets an app write DualSense output reports over USB, through
 * this app's own USB driver, so the profile runs in USB mode with the
 * controller on a cable. The stream pages call these four functions.
 */
let driver: Gta6TriggerDriver | null = null;

/** Starts the profile if it is switched on. Returns whether it is now driving the triggers. */
export const startGta6Triggers = (settings: any): boolean => {
  stopGta6Triggers();
  if (!settings?.gta6_triggers) {
    return false;
  }
  const {UsbRumbleManager} = NativeModules;
  driver = new Gta6TriggerDriver((left, right, heavy, soft) =>
    // LED colour and player lights as the stream pages set them; motors and both trigger effects.
    UsbRumbleManager.setDsController(
      16,
      124,
      16,
      0,
      0,
      0,
      heavy,
      soft,
      left.mode,
      left.params,
      right.mode,
      right.params,
    ),
  );
  driver.start();
  return true;
};

export const stopGta6Triggers = () => {
  if (driver) {
    driver.stop();
    driver = null;
  }
};

/** Hands a rumble packet to the profile. Returns false when the profile is not running. */
export const gta6Rumble = (rumbleData: any, durationMs: number): boolean => {
  if (!driver) {
    return false;
  }
  driver.onRumble(
    rumbleData?.weakMagnitude,
    rumbleData?.strongMagnitude,
    durationMs,
  );
  return true;
};

/** Live trigger positions from the USB driver, 0 to 1. */
export const gta6TriggerPositions = (
  leftTrigger: number,
  rightTrigger: number,
) => {
  driver?.setTriggers(Number(leftTrigger) || 0, Number(rightTrigger) || 0);
};
