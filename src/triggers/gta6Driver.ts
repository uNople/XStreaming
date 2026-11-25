import {DeviceEventEmitter, EmitterSubscription} from 'react-native';
import {getSettings, SETTINGS_CHANGED_EVENT} from '../store/settingStore';
import {
  Gta6Profile,
  normaliseTuning,
  sameEffect,
  TRIGGER_OFF,
  TriggerEffect,
} from './gta6Profile';

/**
 * Sends one controller update: both trigger effects plus the body rumble
 * (0 to 255 each), because a DualSense output report carries them together.
 */
export type TriggerSender = (
  left: TriggerEffect,
  right: TriggerEffect,
  heavy: number,
  soft: number,
) => void;

const TICK_MS = 8; // how often trigger positions and timers are looked at
const REFRESH_SECONDS = 1; // effects are repeated, so they come back after a reconnect
const RUMBLE_MAX_SECONDS = 3; // a lost "stop" packet must not leave the motors running

const seconds = () =>
  (global.performance?.now ? global.performance.now() : Date.now()) / 1000;
const motor = (value: number) =>
  Math.max(0, Math.min(255, Math.round((Number(value) || 0) * 255)));

/** Runs the GTA 6 profile during a stream and keeps the controller in step with it. */
export class Gta6TriggerDriver {
  private send: TriggerSender;
  private profile = new Gta6Profile();
  private timer: ReturnType<typeof setInterval> | null = null;
  private subscription: EmitterSubscription | null = null;
  private sent: [TriggerEffect, TriggerEffect] | null = null;
  private sentAt = -1e9;
  private l2 = 0;
  private r2 = 0;
  private heavy = 0;
  private soft = 0;
  private rumbleUntil = 0;

  constructor(send: TriggerSender) {
    this.send = send;
  }

  start() {
    this.configure(getSettings());
    this.subscription = DeviceEventEmitter.addListener(
      SETTINGS_CHANGED_EVENT,
      settings => this.configure(settings),
    );
    this.timer = setInterval(() => this.update(false), TICK_MS);
    this.update(true);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.subscription?.remove();
    this.subscription = null;
    this.send(TRIGGER_OFF, TRIGGER_OFF, 0, 0);
  }

  /** Live trigger positions, 0 to 1. */
  setTriggers(leftTrigger: number, rightTrigger: number) {
    this.l2 = motor(leftTrigger);
    this.r2 = motor(rightTrigger);
  }

  /** A rumble packet from the console: motor levels 0 to 1, duration in milliseconds. */
  onRumble(weakMagnitude: number, strongMagnitude: number, durationMs: number) {
    const now = seconds();
    this.profile.onPacket(weakMagnitude, strongMagnitude, now);
    this.heavy = motor(strongMagnitude);
    this.soft = motor(weakMagnitude);
    this.rumbleUntil =
      now +
      Math.max(
        0.05,
        Math.min(RUMBLE_MAX_SECONDS, (Number(durationMs) || 0) / 1000),
      );
    this.update(true);
  }

  private configure(settings: any) {
    this.profile.configure(normaliseTuning(settings?.gta6_trigger_tuning));
    this.sent = null;
  }

  private update(force: boolean) {
    const now = seconds();
    if ((this.heavy || this.soft) && now > this.rumbleUntil) {
      this.heavy = 0;
      this.soft = 0;
      force = true;
    }
    const current = this.profile.effects(now, this.l2, this.r2);
    const unchanged =
      this.sent &&
      sameEffect(this.sent[0], current[0]) &&
      sameEffect(this.sent[1], current[1]);
    if (!force && unchanged && now - this.sentAt < REFRESH_SECONDS) {
      return;
    }
    this.sent = current;
    this.sentAt = now;
    this.send(current[0], current[1], this.heavy, this.soft);
  }
}
