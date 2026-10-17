import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { functionCall, functionResult, message } from 'cortico/protocol/open-responses/context.ts';
import { makeFakeHarnessApi } from '../../Cortico/tests/core/helpers.ts';
import definition from '../index.ts';
import { ContinuityPersona } from '../persona/index.ts';

it.each(['[sent #reply]', '[draft discarded]', '[send failed]'])(
  'retains the pressure-crossing batch question, reply and actual receipt: %s', async (receipt) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const dir = mkdtempSync(join(tmpdir(), 'continuity-handoff-batch-'));
    try {
      const cfg = definition.defaults();
      Object.assign(cfg.context, { maxTokens: 10000, softRatio: 0.8, keepRatio: 0.8 });
      cfg.dream.maxRetries = 0;
      const persona = new ContinuityPersona({ memoryDir: dir, cfg, worlds: [] });
      const external: string[] = [];
      let estTokens = 0;
      let handoffs = 0;
      persona.attach(makeFakeHarnessApi({
        injectExternal: text => { external.push(text); },
        toolsTagged: tag => new Set(tag === 'speak' ? ['qq_draft', 'qq_confirm'] : []),
        sessionInfo: id => ({ id, running: 0, snapshot: null, estTokens, hardTokens: null }),
        requestContextHandoff: () => { handoffs++; return true; },
      }));
      const at = (seconds: number) => new Date(Date.UTC(2026, 9, 14, 11, 22, seconds));
      const deliver = async (seconds: number) => {
        vi.setSystemTime(at(seconds));
        await persona.onDelivery({ events: [] });
      };
      await deliver(-60);
      persona.onBatchEnd();
      await deliver(0);
      await deliver(7);
      estTokens = 9000;
      vi.setSystemTime(at(11));
      persona.onBatchEnd();
      await deliver(12);
      vi.setSystemTime(at(19));
      persona.onBatchEnd();
      expect(handoffs).toBe(1);
      const snapshot = [
        message('user', 'An older topic.', { ts: at(-60).toISOString() }),
        functionCall('old', 'qq_draft', '{"text":"old reply"}', { ts: at(-59).toISOString() }),
        functionResult('old', '[draft staged]'),
        message('user', 'When can we talk?', { ts: at(0).toISOString() }),
        functionCall('draft', 'qq_draft', '{"text":"This evening."}', { ts: at(7).toISOString() }),
        functionResult('draft', '[draft staged]'),
        functionCall('confirm', 'qq_confirm', '{"decision":"send"}', { ts: at(9).toISOString() }),
        functionResult('confirm', receipt),
      ];
      const before = structuredClone(snapshot);
      await persona.onHandoff(snapshot, { hardTokens: null });
      const recent = external.at(-1)!;
      expect(recent).toContain('最近的一段');
      expect(recent).toContain('When can we talk?');
      expect(recent).toContain('This evening.');
      expect(recent).toContain(receipt);
      expect(external.join('\n')).not.toContain('old reply');
      expect(snapshot).toEqual(before);
      persona.dream.stop();
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
