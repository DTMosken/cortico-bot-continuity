/**
 * ContinuityPersona 的人格文本分两层:包内默认(persona/*.md)与部署侧
 * `prompts/` 覆盖,同名文件存在即整份替换。控制台保存只落部署侧。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ContinuityPersona } from '../../persona/index.ts';
import { makeCfg } from '../../../Cortico/tests/core/helpers.ts';
import { tmpPersona, cleanup, ctxFor, pick } from './helpers.ts';

const CORE = resolve(import.meta.dirname, '../../persona');
const NAMES = ['ORIENTATION.md', 'PREFIX.md', 'ENV_SECTION.md', 'MEMORY.md', 'CORE.md', 'SUBAGENTS.md', 'SUBAGENT_WORKER.md'];

describe('人格文本的部署侧覆盖', () => {
  let dir: string;
  let prompts: string;
  beforeEach(() => {
    dir = tmpPersona();
    prompts = join(dir, 'prompts');
  });
  afterEach(() => cleanup(dir));

  it('不给 promptsDir:模板读写都落包内', () => {
    const core = new ContinuityPersona({ memoryDir: dir, cfg: makeCfg() });
    for (const name of NAMES) {
      expect(core.textFile(name)).toBe(join(CORE, name));
      expect(core.textWritePath(name)).toBe(join(CORE, name));
    }
  });

  it('给了 promptsDir 但目录还空:读包内默认,写路径已经指向部署侧', () => {
    const core = new ContinuityPersona({ memoryDir: dir, cfg: makeCfg(), promptsDir: prompts });
    expect(existsSync(prompts)).toBe(false);
    for (const name of NAMES) {
      expect(core.textFile(name)).toBe(join(CORE, name));
      expect(core.textWritePath(name)).toBe(join(prompts, name));
    }
    const docs = core.console().promptDocs ?? [];
    for (const key of ['persona.prefix', 'persona.envSection', 'persona.memory', 'persona.subagents', 'persona.subagentWorker']) {
      const doc = docs.find((d) => d.key === key)!;
      expect(doc.path.startsWith(CORE)).toBe(true);
      expect(doc.deploymentPath?.startsWith(prompts)).toBe(true);
    }
  });

  it('部署侧同名文件存在即整份替换:CORE 经 read_file、MEMORY 经拼装、ORIENTATION 经前缀文本都读它', async () => {
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, 'CORE.md'), '# 我的 CORE\n', 'utf8');
    writeFileSync(join(prompts, 'MEMORY.md'), '【只有当下】{{memory.now}}\n', 'utf8');
    writeFileSync(join(prompts, 'ORIENTATION.md'), '我就是我。\n', 'utf8');
    const core = new ContinuityPersona({ memoryDir: dir, cfg: makeCfg(), promptsDir: prompts });

    expect(core.textFile('CORE.md')).toBe(join(prompts, 'CORE.md'));
    // 没放覆盖的那两份仍读包内
    expect(core.textFile('PREFIX.md')).toBe(join(CORE, 'PREFIX.md'));
    expect(core.textFile('ENV_SECTION.md')).toBe(join(CORE, 'ENV_SECTION.md'));

    const memory = core.assembleMemory({ now: new Date('2026-09-11T10:00:00Z'), timezone: 'Asia/Shanghai' });
    expect(memory.startsWith('【只有当下】')).toBe(true);
    expect(memory).not.toContain('MEMORY 0');

    expect(core.orientationText().trim()).toBe('我就是我。');

    const main = core.declareSessions().find((d) => d.id === 'main')!.tools();
    const text = await pick(main, 'read_file').handler({ path: 'CORE.md' }, ctxFor('main'));
    expect(text).toBe('# 我的 CORE\n');
  });

  it('包内默认模板不带任何具名人格的痕迹', () => {
    for (const name of NAMES) {
      expect(readFileSync(join(CORE, name), 'utf8')).not.toMatch(/雪午|xuewu/i);
    }
  });
});
