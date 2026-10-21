import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WakeManager } from '../../persona/rhythm.ts';
import { TimerStore } from '../../../Cortico/src/core/timers.ts';
import { WakeBus } from '../../../Cortico/src/core/bus.ts';
import type { EventEnvelope, CoreApi, WakeItem } from '../../../Cortico/src/core/types.ts';
import { makeFakeHarnessApi, makeTmpDir } from '../../../Cortico/tests/core/helpers.ts';

const TZ = 'Asia/Shanghai';

/** 真 TimerStore + 真 WakeBus 按 core 的接法拼一台观测架 */
function makeRig(tmpDir: string) {
  const bus = new WakeBus({ quietGapMs: 10, minBatchAgeMs: 0, maxBatchAgeMs: 100, maxBatchSize: 100 });
  const timers = new TimerStore(tmpDir);
  const injected: Array<{ text: string; kind: string }> = [];
  const api: CoreApi = makeFakeHarnessApi({
    timers,
    deliveryGate: {
      set: (gate) => bus.setDeliveryGate(gate),
      clear: (id, deliverQueued) => bus.clearDeliveryGate(id, deliverQueued),
      isBlocked: () => bus.isDeliveryBlocked(),
    },
    injectInternal: (text, kind) => {
      injected.push({ text, kind: kind ?? 'notice' });
      bus.push({
        event: {
          cursor: 0,
          type: kind ?? 'notice',
          ts: new Date().toISOString(),
          source: 'persona',
          origin: 'internal',
          text,
        },
      });
    },
  });
  return { bus, timers, api, injected };
}

const evt = (cursor: number, text: string): WakeItem => ({
  event: {
    origin: 'external' as const,
    cursor,
    type: 'qq.message',
    ts: new Date().toISOString(),
    source: 'qq',
    text,
  } as EventEnvelope,
});

describe('WakeManager(schedule_wake 全语义在Persona)', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => {
    vi.useRealTimers();
    tmp.cleanup();
  });

  it('绝对/相对时间与坏输入;回执文本归这里', () => {
    const { api, timers } = makeRig(tmp.dir);
    const wm = new WakeManager(api, () => TZ);
    const before = Date.now();
    expect(wm.schedule({ at: '2099-07-18T20:00:00+08:00', note: '绝对' }))
      .toContain('[system/scheduled] Wake set for 2099-07-18T20:00:00+08:00');
    const rel = wm.schedule({ after_minutes: 0.001, note: '相对' });
    expect(rel).toContain('[system/scheduled]');
    expect(wm.schedule({ at: 'x', after_minutes: 5, note: '' })).toContain('[bad input] use either');
    expect(wm.schedule({ note: '' })).toContain('[bad input] provide at');
    expect(wm.schedule({ at: '明晚八点', note: '' })).toContain('could not parse time');
    expect(timers.list()).toHaveLength(2);
    const relEntry = timers.list().find((e) => (e.payload as { note?: string }).note === '相对')!;
    // 相对时间被抬到 ≥10 秒地板
    expect(Date.parse(relEntry.atIso) - before).toBeGreaterThanOrEqual(9_000);
  });

  it('到期注入 [system/wake] 文本;阻断闹钟到期先解闸,通知与被扣积压同批', async () => {
    vi.useFakeTimers();
    const { api, timers, bus } = makeRig(tmp.dir);
    const wm = new WakeManager(api, () => TZ);
    timers.start();
    const r = wm.schedule({
      at: new Date(Date.now() + 120).toISOString(),
      note: '睡醒',
      block: true,
    });
    expect(r).toContain('Live event delivery is blocked');
    expect(bus.isDeliveryBlocked()).toBe(true);

    const held = evt(1, '普通消息');
    let delivered = false;
    const waiting = bus.nextBatch();
    void waiting.then(() => { delivered = true; });
    bus.push(held);
    await vi.advanceTimersByTimeAsync(119);
    expect(delivered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const batch = await waiting;
    timers.stop();
    expect(batch).toContainEqual(held);
    expect(batch.some(
      (item) => item.event?.origin === 'internal' && item.event!.text.includes('My note: "睡醒"'),
    )).toBe(true);
    expect(bus.isDeliveryBlocked()).toBe(false);
  });

  it('阻断期间紧急事件同样暂存,不越序穿过;经历序=到达序', async () => {
    vi.useFakeTimers();
    const { api, bus, timers } = makeRig(tmp.dir);
    const wm = new WakeManager(api, () => TZ);
    timers.start();
    wm.schedule({ at: new Date(Date.now() + 3600_000).toISOString(), note: '长睡', block: true });

    const held = evt(1, '先到的普通消息');
    const urgent = evt(2, '后到的紧急消息');
    let delivered = false;
    const waiting = bus.nextBatch();
    void waiting.then(() => { delivered = true; });
    bus.push(held);
    bus.push(urgent, { trigger: 'flush' });
    await vi.advanceTimersByTimeAsync(50);
    expect(delivered).toBe(false);
    expect(bus.isDeliveryBlocked()).toBe(true);
    expect(bus.pending()).toBe(2);

    bus.clearDeliveryGate(api.timers.list()[0].id);
    expect(await waiting).toEqual([held, urgent]);
    timers.stop();
  });

  it('关键词字面命中:取消闹钟、解闸、注入唤醒文本,与积压同批', async () => {
    const { api, bus, timers } = makeRig(tmp.dir);
    const wm = new WakeManager(api, () => TZ);
    timers.start();
    wm.schedule({
      at: new Date(Date.now() + 3600_000).toISOString(),
      note: '等紧急消息',
      block: true,
      wake_keyword: '紧急',
    });
    const trigger = evt(2, '这是一条紧急通知');
    const waiting = bus.nextBatch();
    bus.push(trigger);

    const batch = await waiting;
    timers.stop();
    expect(batch.some(
      (item) => item.event?.origin === 'internal' && item.event!.text.includes('literal keyword "紧急"'),
    )).toBe(true);
    expect(batch).toContainEqual(trigger);
    expect(api.timers.list()).toHaveLength(0);
    expect(bus.isDeliveryBlocked()).toBe(false);
  });

  it('溢出放行一批并保留闹钟与闸门;溢出通知随批同行', async () => {
    const { api, bus, timers } = makeRig(tmp.dir);
    const wm = new WakeManager(api, () => TZ);
    timers.start();
    wm.schedule({
      at: new Date(Date.now() + 3600_000).toISOString(),
      note: '稍后再醒',
      block: true,
      overflow_limit: 2,
    });
    const waiting = bus.nextBatch();
    for (let cursor = 1; cursor <= 3; cursor++) bus.push(evt(cursor, `消息${cursor}`));

    const batch = await waiting;
    timers.stop();
    expect(batch.filter((item) => item.event?.origin === 'external')).toHaveLength(3);
    expect(batch.some(
      (item) => item.event?.origin === 'internal' && item.event!.text.includes('[system/wake-overflow]'),
    )).toBe(true);
    expect(api.timers.list()).toHaveLength(1);
    expect(bus.isDeliveryBlocked()).toBe(true);
  });

  it('重启恢复:attach 时从定时器表重装阻断闸门', () => {
    vi.useFakeTimers();
    const { api: api1, timers: t1 } = makeRig(tmp.dir);
    const wm1 = new WakeManager(api1, () => TZ);
    wm1.schedule({ at: new Date(Date.now() + 3600_000).toISOString(), note: '恢复后继续睡', block: true });
    t1.stop();

    // 同一目录再起一台:构造即读盘,WakeManager 构造时重装闸门
    const rig2 = makeRig(tmp.dir);
    void new WakeManager(rig2.api, () => TZ);
    expect(rig2.bus.isDeliveryBlocked()).toBe(true);
  });

  it('列出按到期时间排序的闹钟，保留旧条目并排除 Dream 重试', () => {
    const { api, timers } = makeRig(tmp.dir);
    timers.set('2099-01-02T08:00:00+08:00', { note: '旧闹钟', setAt: '2026-01-01T00:00:00Z' });
    timers.set('2099-01-01T00:00:00Z', { kind: 'continuity.dream-retry' });
    const wm = new WakeManager(api, () => TZ);
    wm.schedule({ at: '2099-01-01T08:00:00+08:00', note: '新闹钟', repeat: true });

    expect(JSON.parse(wm.list()).wakes).toMatchObject([
      { at: '2099-01-01T08:00:00+08:00', note: '新闹钟', repeat: true, timezone: TZ },
      { note: '旧闹钟', repeat: false },
    ]);
    const retry = timers.list().find(e => e.payload.kind === 'continuity.dream-retry')!;
    expect(wm.cancel({ id: retry.id })).toContain('[wake not found]');
    expect(timers.list()).toHaveLength(3);
  });

  it('取消闹钟后不触发，取消结果落盘且未知 ID 不改变表', async () => {
    vi.useFakeTimers();
    const { api, timers, injected } = makeRig(tmp.dir);
    const wm = new WakeManager(api, () => TZ);
    timers.start();
    wm.schedule({ after_minutes: 1, note: '取消我' });
    const id = JSON.parse(wm.list()).wakes[0].id;
    expect(wm.cancel({ id })).toContain('[system/cancelled]');
    expect(wm.cancel({ id })).toContain('[wake not found]');
    expect(wm.cancel({})).toContain('[bad input]');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(injected).toEqual([]);
    expect(new TimerStore(tmp.dir).list()).toEqual([]);
    timers.stop();
  });

  it('取消最后一个阻断闹钟立即投递积压', async () => {
    const { api, timers, bus } = makeRig(tmp.dir);
    const wm = new WakeManager(api, () => TZ);
    wm.schedule({ after_minutes: 60, note: '阻断', block: true });
    const waiting = bus.nextBatch();
    const held = evt(1, '积压消息');
    bus.push(held);
    wm.cancel({ id: JSON.parse(wm.list()).wakes[0].id });
    expect(bus.isDeliveryBlocked()).toBe(false);
    expect(await waiting).toEqual([held]);
    expect(timers.list()).toEqual([]);
  });

  it('取消当前阻断闹钟后由下一个闹钟继续阻断', () => {
    const { api, bus } = makeRig(tmp.dir);
    const wm = new WakeManager(api, () => TZ);
    wm.schedule({ after_minutes: 1, note: '先醒', block: true });
    wm.schedule({ after_minutes: 2, note: '后醒', block: true });
    const wakes = JSON.parse(wm.list()).wakes;
    wm.cancel({ id: wakes[0].id });
    expect(bus.isDeliveryBlocked()).toBe(true);
    wm.cancel({ id: wakes[1].id });
    expect(bus.isDeliveryBlocked()).toBe(false);
  });

  it('repeat 只接受 at；after_minutes 保持一次性', () => {
    const { api, timers } = makeRig(tmp.dir);
    const wm = new WakeManager(api, () => TZ);
    expect(wm.schedule({ after_minutes: 1, note: '', repeat: true })).toContain('[bad input]');
    expect(wm.schedule({ at: '2099-01-01T00:00:00Z', note: '', repeat: 'true' })).toContain('[bad input]');
    expect(timers.list()).toEqual([]);
  });

  it('每日闹钟跨天保留 ID，首次到期解除阻断且取消后不再重复', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T07:59:00+08:00'));
    const { api, timers, injected, bus } = makeRig(tmp.dir);
    const wm = new WakeManager(api, () => TZ);
    timers.start();
    wm.schedule({ at: '2026-10-21T08:00:00+08:00', note: '每天', repeat: true, block: true });
    const id = JSON.parse(wm.list()).wakes[0].id;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(injected.filter(e => e.kind === 'wake.due')).toHaveLength(1);
    expect(bus.isDeliveryBlocked()).toBe(false);
    expect(JSON.parse(wm.list()).wakes).toMatchObject([
      { id, at: '2026-10-22T08:00:00.000+08:00', repeat: true, block: false },
    ]);
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(injected.filter(e => e.kind === 'wake.due')).toHaveLength(2);
    expect(JSON.parse(wm.list()).wakes[0].id).toBe(id);
    wm.cancel({ id });
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(injected.filter(e => e.kind === 'wake.due')).toHaveLength(2);
    timers.stop();
  });

  it('重启后只补一次过期通知并安排未来的当地时刻', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T07:00:00+08:00'));
    const first = makeRig(tmp.dir);
    const wm = new WakeManager(first.api, () => TZ);
    wm.schedule({ at: '2026-10-21T08:00:00+08:00', note: '恢复', repeat: true });
    const id = JSON.parse(wm.list()).wakes[0].id;
    vi.setSystemTime(new Date('2026-10-25T09:00:00+08:00'));
    const restored = makeRig(tmp.dir);
    const wm2 = new WakeManager(restored.api, () => 'UTC');
    restored.timers.start();
    expect(restored.injected).toHaveLength(1);
    expect(JSON.parse(wm2.list()).wakes).toMatchObject([
      { id, at: '2026-10-26T08:00:00.000+08:00', timezone: TZ, repeat: true },
    ]);
    restored.timers.stop();
  });

  it('关键词提前唤醒取消每日闹钟的整个重复序列', async () => {
    vi.useFakeTimers();
    const { api, timers, bus, injected } = makeRig(tmp.dir);
    const wm = new WakeManager(api, () => TZ);
    timers.start();
    wm.schedule({ at: new Date(Date.now() + 60_000).toISOString(), note: '提前醒', repeat: true,
      block: true, wake_keyword: '紧急' });
    bus.push(evt(1, '紧急通知'));
    expect(JSON.parse(wm.list())).toEqual({ wakes: [] });
    expect(bus.isDeliveryBlocked()).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * 24 * 3600_000);
    expect(injected).toHaveLength(1);
    timers.stop();
  });

  it.each([
    ['2026-10-03T08:00:00+10:00', '2026-10-04T08:00:00.000+11:00'],
    ['2026-04-04T08:00:00+11:00', '2026-04-05T08:00:00.000+10:00'],
    ['2026-10-03T02:30:00+10:00', '2026-10-05T02:30:00.000+11:00'],
    ['2026-04-05T02:30:00+11:00', '2026-04-06T02:30:00.000+10:00'],
  ])('每日 %s 跨夏令时保持当地时刻，每个日期最多一次', async (at, next) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(at) - 1000));
    const { api, timers, injected } = makeRig(tmp.dir);
    const wm = new WakeManager(api, () => 'Australia/Sydney');
    timers.start();
    wm.schedule({ at, note: '当地时刻', repeat: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.parse(wm.list()).wakes[0].at).toBe(next);
    expect(injected).toHaveLength(1);
    timers.stop();
  });
});
