import type {Settings} from '../store/settingStore';

export const maxRumbleStrength = 250;

const legacyGains: Record<number, [number, number]> = {
  1: [0.5, 0.4],
  2: [0.8, 0.9],
  3: [1, 1],
  4: [1.5, 2],
  5: [2, 2.5],
};

const gains = ({rumble_strength, rumble_intensity}: Settings) => {
  if (
    typeof rumble_strength !== 'number' ||
    !Number.isFinite(rumble_strength)
  ) {
    return legacyGains[rumble_intensity] ?? legacyGains[3];
  }
  const gain = Math.max(0, Math.min(maxRumbleStrength, rumble_strength)) / 100;
  return [gain, gain];
};

export const rumbleStrength = (settings: Settings) => {
  const [weak, strong] = gains(settings);
  return Math.round((weak + strong) * 50);
};

const amplitude = (raw?: number, gain = 1) =>
  typeof raw === 'number' && Number.isFinite(raw)
    ? Math.round(Math.max(0, Math.min(1, raw * gain)) * 65535)
    : 0;

export const controllerRumble = (
  settings: Settings,
  packet: {
    weakMagnitude?: number;
    strongMagnitude?: number;
    leftTrigger?: number;
    rightTrigger?: number;
  },
): [number, number, number, number] => {
  const [weak, strong] = settings.vibration ? gains(settings) : [0, 0];
  return [
    amplitude(packet.weakMagnitude, weak),
    amplitude(packet.strongMagnitude, strong),
    amplitude(packet.leftTrigger),
    amplitude(packet.rightTrigger),
  ];
};
