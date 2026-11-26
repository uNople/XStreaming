import {DeviceEventEmitter, EmitterSubscription} from 'react-native';
import {getSettings, SETTINGS_CHANGED_EVENT} from '../store/settingStore';
import {
  Gta6Profile,
  normaliseTuning,
  sameEffect,
  TRIGGER_OFF,
  TriggerEffect,
} from './gta6Profile';

export type TriggerSender = (left: TriggerEffect, right: TriggerEffect) => void;

const TICK_MS = 8; // how often trigger positions and timers are looked at
const REFRESH_SECONDS = 1; // effects are repeated, so they come back after a reconnect

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
  private enabled = true;

  constructor(send: TriggerSender) {
    this.send = send;
  }

  /** Whether the profile currently believes the player is in a vehicle. */
  get vehicle() {
    return this.profile.vehicle;
  }

  start() {
    this.configure(getSettings());
    this.subscription = DeviceEventEmitter.addListener(
      SETTINGS_CHANGED_EVENT,
      settings => this.configure(settings),
    );
    this.timer = setInterval(() => this.update(), TICK_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.subscription?.remove();
    this.subscription = null;
    this.send(TRIGGER_OFF, TRIGGER_OFF);
  }

  /** Live trigger positions, 0 to 1. */
  setTriggers(leftTrigger: number, rightTrigger: number) {
    this.l2 = motor(leftTrigger);
    this.r2 = motor(rightTrigger);
  }

  /** Use the console's rumble to update the trigger profile. */
  onRumble(weakMagnitude: number, strongMagnitude: number) {
    this.profile.onPacket(weakMagnitude, strongMagnitude, seconds());
    this.update();
  }

  private configure(settings: any) {
    this.enabled = !!settings?.gta6_triggers;
    this.profile.configure(normaliseTuning(settings?.gta6_trigger_tuning));
    this.update();
  }

  private update() {
    const now = seconds();
    const effects = this.profile.effects(now, this.l2, this.r2);
    const current: [TriggerEffect, TriggerEffect] = this.enabled
      ? effects
      : [TRIGGER_OFF, TRIGGER_OFF];
    const unchanged =
      this.sent &&
      sameEffect(this.sent[0], current[0]) &&
      sameEffect(this.sent[1], current[1]);
    if (unchanged && now - this.sentAt < REFRESH_SECONDS) {
      return;
    }
    this.sent = current;
    this.sentAt = now;
    this.send(current[0], current[1]);
  }
}
