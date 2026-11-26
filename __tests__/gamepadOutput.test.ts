import {describe, expect, jest, test} from '@jest/globals';
import {createGamepadOutput} from '../src/utils/gamepadOutput';

const neutral = {A: 0, LeftTrigger: 0, RightThumbXAxis: 0};

const setup = () => {
  let callback: FrameRequestCallback | undefined;
  const schedule = jest.fn((next: FrameRequestCallback) => {
    callback = next;
    return 1;
  });
  const cancel = jest.fn(() => {
    callback = undefined;
  });
  const post = jest.fn((_state: Readonly<Record<string, number>>) => true);
  const output = createGamepadOutput(post, schedule, cancel);
  return {output, post, schedule, runFrame: () => callback?.(0)};
};

describe('iPad gamepad delivery', () => {
  test('sends one unchanged state even across 250 motion ticks', () => {
    const {output, post, schedule} = setup();
    for (let tick = 0; tick < 250; tick++) {
      output.update({...neutral});
    }
    expect(post).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
  });

  test('coalesces analog changes and preserves button and trigger edges', () => {
    const {output, post, runFrame, schedule} = setup();
    output.update(neutral);
    output.update({...neutral, RightThumbXAxis: 0.2});
    output.update({...neutral, RightThumbXAxis: 0.6});
    expect(post).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    runFrame();
    expect(post).toHaveBeenLastCalledWith({...neutral, RightThumbXAxis: 0.6});

    output.update({...neutral, RightThumbXAxis: 0.8});
    const pressed = {...neutral, A: 1, LeftTrigger: 0.7, RightThumbXAxis: 0.9};
    output.update(pressed);
    expect(post).toHaveBeenLastCalledWith(pressed);
    output.update({...pressed, A: 0, LeftTrigger: 0});
    expect(post).toHaveBeenLastCalledWith({...pressed, A: 0, LeftTrigger: 0});
    runFrame();
    expect(post).toHaveBeenCalledTimes(4);
  });

  test('resends the latest state when the WebView is ready or reloads', () => {
    const {output, post, runFrame} = setup();
    post.mockReturnValueOnce(false);
    const held = {...neutral, A: 1};
    output.update(held);
    output.sync();
    expect(post.mock.calls).toEqual([[held], [held]]);

    output.update({...held, RightThumbXAxis: 0.5});
    output.dispose();
    runFrame();
    expect(post).toHaveBeenCalledTimes(2);
  });
});
