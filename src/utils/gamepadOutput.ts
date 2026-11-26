export const gamepadButtons = [
  'A',
  'B',
  'X',
  'Y',
  'LeftShoulder',
  'RightShoulder',
  'View',
  'Menu',
  'LeftThumb',
  'RightThumb',
  'DPadUp',
  'DPadDown',
  'DPadLeft',
  'DPadRight',
  'Nexus',
] as const;

type GamepadState = Readonly<Record<string, number>>;
const edges = [...gamepadButtons, 'LeftTrigger', 'RightTrigger'];

/** Keep the latest analog values per frame and forward presses and releases immediately. */
export const createGamepadOutput = (
  post: (state: GamepadState) => boolean,
  schedule = requestAnimationFrame,
  cancel = cancelAnimationFrame,
) => {
  let latest: GamepadState | undefined;
  let sent: GamepadState | undefined;
  let frame: number | undefined;

  const dispose = () => {
    if (frame !== undefined) {
      cancel(frame);
      frame = undefined;
    }
  };

  const flush = () => {
    frame = undefined;
    if (
      latest &&
      (!sent || Object.keys(latest).some(key => latest?.[key] !== sent?.[key]))
    ) {
      if (post(latest)) {
        sent = latest;
      }
    }
  };

  return {
    update(state: GamepadState) {
      latest = state;
      if (!sent || edges.some(key => !!sent?.[key] !== !!state[key])) {
        dispose();
        flush();
      } else if (
        frame === undefined &&
        Object.keys(state).some(key => state[key] !== sent?.[key])
      ) {
        frame = schedule(flush);
      }
    },
    sync() {
      sent = undefined;
      dispose();
      flush();
    },
    dispose,
  };
};
