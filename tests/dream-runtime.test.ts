import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { message, record } from 'cortico/protocol/open-responses/context.ts';
import { FakeLLM, makeCfg, makeFakeHarnessApi, toolReply } from '../../Cortico/tests/core/helpers.ts';
import { GitWorkspaceMemory } from '../base/persona/memory.ts';
import { ContinuityPersona } from '../persona/index.ts';

it.each([false, true])('runs Dream after attaching CoreApi without a Bot onStart hook (image=%s)', async image => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-attached-api-'));
  const cfg = makeCfg(); Object.assign(cfg.dream, { maxRetries: 0 });
  const memory = new GitWorkspaceMemory({ memoryDir: dir });
  const llm = new FakeLLM();
  llm.fallback = () => {
    const receipt = llm.calls.at(-1)!.messages.filter(entry => entry.role === 'tool').at(-1)?.content ?? '';
    if (!receipt.includes('"items"')) {
      if (receipt.includes('[blob ')) return toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]);
      return toolReply([{ name: 'dream_materials', args: {} }]);
    }
    const items = JSON.parse(receipt.split('\n', 1)[0]).items;
    if (image) return toolReply([{ name: 'read_file', args: { path: items[0].unreadImages[0].handle.slice(4) } }]);
    return toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]);
  };
  const persona = new ContinuityPersona({ memoryDir: dir, cfg, worlds: [] });
  try {
    persona.attach(makeFakeHarnessApi({ llm, blob: handle => memory.blobs.get(handle) }));
    const source = image ? record({ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'caption' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
    ] }) : message('user', 'material');
    await persona.dream.schedule([source]);
    expect(persona.dream.getStatus()).toMatchObject({ pendingMaterials: 0 });
    expect(persona.dream.getStatus().runs[0]).toMatchObject({ status: 'complete', unreadImages: [] });
    expect(llm.calls.length).toBeGreaterThan(0);
  } finally { persona.dream.stop(); persona.stopSubagents(); await persona.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
