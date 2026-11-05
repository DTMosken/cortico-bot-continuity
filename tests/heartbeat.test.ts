import { afterEach, expect, it, vi } from 'vitest';
import { Heartbeat } from '../base/persona/heartbeat.ts';

afterEach(() => { vi.useRealTimers(); });

function heartbeat() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const start = Date.now();
  const fires: number[] = [];
  const beat = new Heartbeat(() => 1000, () => { fires.push(Date.now() - start); });
  return { beat, fires, at: (ms: number) => vi.advanceTimersByTimeAsync(start + ms - Date.now()) };
}

it('doubles the interval on idle ticks up to the cap', async () => {
  const { beat, fires, at } = heartbeat();
  beat.start();
  await at(24_000);
  expect(fires).toEqual([1000, 2000, 4000, 8000, 16_000, 24_000]);
  beat.stop();
});

it('re-arms at the baseline when activity arrives during a backoff', async () => {
  const { beat, fires, at } = heartbeat();
  beat.start();
  await at(25_000);
  // 回退中的下一拍原定在 32000;活动到达后改为基线间隔。
  beat.noteActivity();
  await at(29_000);
  expect(fires.slice(6)).toEqual([26_000, 27_000, 29_000]);
  beat.stop();
});

it('keeps the baseline schedule when activity arrives without a backoff', async () => {
  const { beat, fires, at } = heartbeat();
  beat.start();
  await at(500);
  beat.noteActivity();
  await at(2000);
  expect(fires).toEqual([1000, 2000]);
  beat.stop();
});

it('does not arm a stopped heartbeat on activity', async () => {
  const { beat, fires, at } = heartbeat();
  beat.start();
  await at(8000);
  beat.stop();
  beat.noteActivity();
  await at(20_000);
  expect(fires).toEqual([1000, 2000, 4000, 8000]);
});
