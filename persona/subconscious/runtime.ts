/** Dream uses CoreApi directly; a full runtime supplies shared telemetry and blob storage when attached. */
import { createHash } from 'node:crypto';
import type { Core } from 'cortico/core/core.ts';
import type { BlobStore, CoreApi } from 'cortico/core/types.ts';
import { SessionTracker } from 'cortico/core/sessions.ts';
import type { BotConfig } from '../../index.ts';
import { dreamConfig } from '../config.ts';
import { runWorker, type WorkerHost } from '../subagents/runtime.ts';
import type { DreamDeps } from './index.ts';
import { DreamInputBudgetError } from './materials.ts';

export function createDreamRuntime(core: CoreApi, cfg: BotConfig, blobs: BlobStore, runtime: () => Core | null): Pick<DreamDeps, 'fork' | 'internImage'> {
  const fallbackSessions = new SessionTracker(cfg.timezone);
  const internBlobs: WorkerHost['internBlobs'] = inputs => {
    const host = runtime();
    if (host) return host.internBlobs(inputs);
    return inputs?.map(input => {
      if ('bytes' in input) {
        const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' } as Record<string, string>)[input.mime] ?? 'bin';
        const handle = blobs.put(`blobs/${createHash('sha256').update(input.bytes).digest('hex')}.${extension}`, input.bytes, input.mime);
        return { handle, mime: input.mime, fallbackText: input.fallbackText };
      }
      return { ...input, mime: 'mime' in input ? input.mime : core.blob(input.handle)?.mime ?? 'application/octet-stream' };
    });
  };
  return {
    internImage: (bytes, mime) => internBlobs([{ bytes, mime, fallbackText: 'image' }])![0],
    fork: async (options, onResponse) => {
      const spec = cfg.providers[cfg.activeProvider]?.spec;
      if (!spec) throw new Error('Dream provider has no selected model');
      const config = dreamConfig(cfg.dream);
      const result = await runWorker({ core: { sessions: runtime()?.sessions ?? fallbackSessions, internBlobs },
        llm: core.llm.bind?.() ?? core.llm, spec: structuredClone(spec), messages: options.messages, tools: options.tools ?? [],
        role: options.id, label: 'Dream', log: core.log.child('dream'), signal: new AbortController().signal,
        maxRounds: config.maxRounds, softRounds: config.softRounds, contextTokens: Infinity,
        stopped: () => false, finished: () => options.stopWhen?.() ?? false, progress() {}, wrapUpHint: options.wrapUpHint, onResponse });
      if (result.reason === 'context_limit') throw new DreamInputBudgetError('Dream input exceeds the model context limit; unconfirmed materials retained.');
      return result.text;
    },
  };
}
