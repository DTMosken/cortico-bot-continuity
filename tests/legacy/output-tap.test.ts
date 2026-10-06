import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { OutputTap, World } from 'cortico/core/types.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { Cormini } from '../../base/persona/persona.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function mergedTap(taps: OutputTap[]): OutputTap {
  const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-output-tap-'));
  dirs.push(memoryDir);
  const worlds: World[] = taps.map((tap, index) => ({
    id: `receiver${index}`,
    envPromptVars: () => null,
    tools: () => [],
    outputTap: () => tap,
    start: async () => {},
    stop: async () => {},
  }));
  return new Cormini({ memoryDir, worlds }).declareSessions()[0].outputTap!;
}

const delta: StreamEvent = {
  type: 'response.output_text.delta', sequence_number: 0, output_index: 0,
  item_id: 'item', content_index: 0, delta: '正文',
};

it('多个输出接收器中未声明 externalizes 的正文输出仍阻止抢占', () => {
  const received: string[] = [];
  const tap = mergedTap([
    { onEvent: () => {}, externalizes: () => false },
    { onEvent: event => { if (event.type === 'response.output_text.delta') received.push(event.delta); } },
  ]);
  tap.onEvent(delta);
  expect(received).toEqual(['正文']);
  expect(tap.externalizes!(delta)).toBe(true);
});

it('全部接收器明确声明没有外部输出时仍允许抢占', () => {
  const tap = mergedTap([
    { onEvent: () => {}, externalizes: () => false },
    { onEvent: () => {}, externalizes: () => false },
  ]);
  expect(tap.externalizes!(delta)).toBe(false);
});
