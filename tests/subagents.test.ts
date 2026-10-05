import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Core } from 'cortico/core/core.ts';
import type { World, WorldHost, ToolDef, OutputTap } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { itemText, message } from 'cortico/protocol/open-responses/context.ts';
import { FakeLLM, toolReply, textReply } from '../../Cortico/tests/core/helpers.ts';
import type { ChatMessage } from '../../Cortico/tests/core/fixture-types.ts';
import { composeDefaults } from '../index.ts';
import { ContinuityPersona } from '../persona/index.ts';
import { SUBAGENTS_DEFAULTS, subagentsConfig, validateSubagentsDraft, type SubagentsConfig } from '../persona/subagents/config.ts';
import { TaskStore, type TaskRecord } from '../persona/subagents/store.ts';
import { balancedSnapshot, runWorker } from '../persona/subagents/runtime.ts';
import { functionResult, responseRecords } from 'cortico/protocol/open-responses/context.ts';

const fixtures: Array<{ core: Core; persona: ContinuityPersona; dir: string }> = [];
const releases: Array<() => void> = [];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  return { promise, release };
}
const finish = (summary = 'done', result = 'full result', status = 'complete') =>
  toolReply([{ name: 'subagent_finish', args: { status, summary, result } }]);

async function setup(options: { subagents?: Partial<SubagentsConfig>; worlds?: World[]; dir?: string; workerSetup?: (worker: FakeLLM) => void } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'continuity-subagents-'));
  const cfg = composeDefaults();
  cfg.providers = { fixture: { kind: 'openai-responses-compat', baseUrl: 'https://model.test', spec: { model: 'test-model', thinking: false } } };
  cfg.activeProvider = 'fixture'; cfg.subagents = subagentsConfig(options.subagents);
  if (!existsSync(join(dir, 'config.json'))) writeFileSync(join(dir, 'config.json'), '{}\n');
  const worlds = options.worlds ?? [];
  const persona = new ContinuityPersona({ memoryDir: join(dir, 'memory'), deploymentDir: dir, promptsDir: join(dir, 'prompts'),
    dataDir: join(dir, 'data'), cfg, worlds });
  const worker = new FakeLLM(); const main = new FakeLLM();
  options.workerSetup?.(worker);
  const core = new Core({ config: cfg, rootDir: dir, memoryDir: persona.memoryDir, dataDir: join(dir, 'data'), secret: () => '' },
    { persona, worlds, llm: { respond: (request, options) => (options?.role === 'subagent' ? worker : main).respond(request, options) } });
  fixtures.push({ core, persona, dir });
  persona.setSubagentsRuntime(core);
  await core.start();
  await vi.waitFor(() => expect(core.loop.getStatus().batchesHandled).toBeGreaterThan(0));
  const invokeTool = async (name: string, args: Record<string, unknown>) => {
    const def = persona.declareSessions().find(decl => decl.id === 'main')!.tools().find(tool => tool.name === name)!;
    return def.handler(args, { role: 'main', log: nullLogger() });
  };
  const spawn = async (task = 'work', tools: string[] = [], materials: string[] = []) => {
    const outcome = await invokeTool('subagent_spawn', { task, tools, materials });
    const receipt = typeof outcome === 'string' ? outcome : outcome.text;
    const taskId = receipt.match(/^任务 ID：(.+)$/m)?.[1];
    return { accepted: taskId !== undefined, taskId: taskId ?? '', reason: receipt, receipt };
  };
  const idle = () => vi.waitFor(() => expect(persona.subagentsState().running).toBe(0));
  const get = (taskId: string, offsetChars = 0) => persona.subagentsInvoke('get', [{ taskId, offsetChars }]) as Promise<{
    id: string; status: string; summary: string; result: string; resultChars: number; nextOffset: number | null; maxRounds: number;
  }>;
  const save = (patch: Record<string, unknown>) => {
    const state = persona.subagentsState();
    return persona.subagentsInvoke('saveDraft', [{ ...state.values, ...patch }, state.revision]);
  };
  return { dir, cfg, core, persona, worker, main, worlds, spawn, idle, get, save, invokeTool };
}
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const fixture of fixtures.splice(0)) {
    fixture.persona.dispose(); await fixture.core.stop();
    await vi.waitFor(() => expect(fixture.persona.subagentsState().running).toBe(0));
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

class FilesWorld implements World {
  host!: WorldHost;
  id = 'files'; file: string; envFile: string; defs: ToolDef[];
  constructor(dir: string) {
    this.file = join(dir, 'world.txt'); writeFileSync(this.file, 'original');
    this.envFile = join(dir, 'ENV_PROMPT.md'); writeFileSync(this.envFile, 'Selected World rules: {{world.fact}}');
    this.defs = [
      { name: 'files_read', description: 'Read the record.', tags: ['read'], parameters: {}, handler: async () => readFileSync(this.file, 'utf8') },
      { name: 'files_write', description: 'Replace the record.', tags: ['act'], parameters: {}, handler: async args => { writeFileSync(this.file, String(args.text)); return 'updated'; } },
      { name: 'files_send', description: 'Send a message.', tags: ['speak'], parameters: {}, handler: async () => 'sent' },
    ];
  }
  tools() { return this.defs; }
  envPromptVars() { return { 'world.fact': 'read current content' }; }
  console() { return { label: '文件 World', promptDocs: [{ key: 'worlds.files.env', title: 'Environment', description: '', role: 'envPrompt' as const, path: this.envFile }] }; }
  async start(host: WorldHost) { this.host = host; } async stop() {}
}
function worldFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'continuity-subagents-'));
  return { dir, world: new FilesWorld(dir) };
}

describe('background worker contract', () => {
  it('returns IDs before generation finishes and delivers only summaries in completion order', async () => {
    const f = await setup(); const held = gate();
    const chat = f.worker.chat.bind(f.worker);
    vi.spyOn(f.worker, 'chat').mockImplementation(async (spec, messages, tools, options) => {
      const task = messages.find(msg => msg.role === 'user')!.content!.includes('\nslow\n') ? 'slow' : 'fast';
      if (task === 'slow') await held.promise;
      f.worker.script(finish(task, task + ' private detailed work'));
      return chat(spec, messages, tools, options);
    });
    const slow = await f.spawn('slow'); const fast = await f.spawn('fast');
    expect(slow.accepted && fast.accepted).toBe(true); expect(slow.taskId).not.toBe(fast.taskId);
    expect(slow.receipt).toBe('━━━ 子代理任务已启动 ━━━\n任务 ID：' + slow.taskId + '\n状态：running');
    await vi.waitFor(() => expect(f.persona.subagentsState().records.find(task => task.id === fast.taskId)?.status).toBe('complete'));
    await vi.waitFor(() => expect(f.core.store.range({ origin: 'internal' }).filter(event => event.type === 'continuity.subagent')).toHaveLength(1));
    held.release(); await f.idle();
    await vi.waitFor(() => expect(f.core.store.range({ origin: 'internal' }).filter(event => event.type === 'continuity.subagent')).toHaveLength(2));
    const events = f.core.store.range({ origin: 'internal' }).filter(event => event.type === 'continuity.subagent');
    expect(events.map(event => event.text!.match(/^任务 ID：(.+)$/m)?.[1])).toEqual([fast.taskId, slow.taskId]);
    expect(events[0].text).toContain('━━━ 子代理任务结束 ━━━\n任务 ID：' + fast.taskId + '\n状态：complete');
    expect(events[0].text).toContain('━━━ 摘要 ━━━\nfast');
    expect(events[0].text).toContain('读取：subagent_get(taskId="' + fast.taskId + '")');
    const taskList = await f.invokeTool('subagent_list', { limit: 1, status: 'complete' });
    expect(taskList).toContain('━━━ 子代理任务列表 ━━━\n任务总数：2\n本页任务数：1');
    expect(taskList).toContain('下一页：subagent_list(offset=1, limit=1, status="complete")');
    expect(taskList).not.toContain('private detailed work');
    expect(events.map(event => event.text).join('')).not.toContain('private detailed work');
    expect((await f.get(slow.taskId)).result).toBe('slow private detailed work');
  });

  it('rejects capacity overflow without adding a queued task', async () => {
    const f = await setup({ subagents: { maxWorkers: 1 } }); const held = gate();
    const chat = f.worker.chat.bind(f.worker);
    vi.spyOn(f.worker, 'chat').mockImplementation(async (...args) => { await held.promise; return chat(...args); });
    expect((await f.spawn()).accepted).toBe(true);
    const rejected = await f.spawn('extra'); expect(rejected.accepted).toBe(false); expect(rejected.reason).toContain('no task was queued');
    expect(rejected.receipt).toContain('━━━ 子代理任务未启动 ━━━\n原因：');
    expect(f.persona.subagentsState().records).toHaveLength(1);
    held.release(); await f.idle();
  });

  it('uses independent identity, worker rules, selected materials and selected World environments', async () => {
    const { dir, world } = worldFixture();
    mkdirSync(join(dir, 'prompts')); writeFileSync(join(dir, 'prompts', 'ORIENTATION.md'), 'Shared identity');
    writeFileSync(join(dir, 'prompts', 'SUBAGENTS.md'), 'MAIN DELEGATION RULES {{subagents.maxWorkers}}');
    writeFileSync(join(dir, 'prompts', 'SUBAGENT_WORKER.md'), 'WORKER RULES {{subagents.maxRounds}} {{subagents.availableTools}}');
    mkdirSync(join(dir, 'worlds', world.id), { recursive: true });
    writeFileSync(join(dir, 'worlds', world.id, 'ENV_PROMPT.md'), 'Deployed World rule {{world.fact}}');
    const other: World = { id: 'other', envPromptVars: () => ({}), tools: () => [], start: async () => {}, stop: async () => {},
      console: () => ({ promptDocs: [{ key: 'worlds.other.env', title: 'Other', description: '', role: 'envPrompt', path: world.envFile }] }) };
    const f = await setup({ dir, worlds: [world, other] });
    writeFileSync(join(f.persona.memoryDir, 'CONSTITUTION.md'), 'Shared constitution');
    writeFileSync(join(f.persona.memoryDir, 'WORLDVIEW.md'), 'Unselected worldview');
    f.core.session.append(message('user', 'Private main history'));
    f.worker.script(finish());
    const task = await f.spawn('Selected work', ['files_read'], ['Selected material\n"Quoted text"', 'Second material']); await f.idle();
    const input = f.worker.calls[0];
    expect(input.tools?.map(tool => tool.name)).toEqual(['files_read', 'subagent_finish', 'subagent_notify']);
    const system = input.messages.find(msg => msg.role === 'system')!.content!;
    expect(system).toContain('Shared identity'); expect(system).toContain('Shared constitution');
    expect(system).toContain('WORKER RULES ' + SUBAGENTS_DEFAULTS.maxRounds); expect(system).toContain('Deployed World rule read current content');
    expect(system).not.toContain('MAIN DELEGATION RULES'); expect(system).not.toContain('Unselected worldview'); expect(system).not.toContain('otherWorld');
    expect(input.messages.map(msg => msg.content).join('')).not.toContain('Private main history');
    expect(input.messages.find(msg => msg.role === 'user')!.content!).toBe(
      '━━━ 子代理任务 ━━━\n任务 ID：' + task.taskId + '\n\n━━━ 任务要求 ━━━\nSelected work'
      + '\n\n━━━ 材料 1 ━━━\nSelected material\n"Quoted text"\n\n━━━ 材料 2 ━━━\nSecond material');
    const mainSystem = itemText(f.core.session.records[0].item);
    expect(mainSystem).toContain('MAIN DELEGATION RULES'); expect(mainSystem).not.toContain('WORKER RULES');
    expect(f.persona.declareSessions().find(decl => decl.id === 'dream')!.tools().map(tool => tool.name)).not.toContain('subagent_spawn');
  });

  it('continues running across a main context handoff', async () => {
    const f = await setup(); const held = gate(); const chat = f.worker.chat.bind(f.worker);
    vi.spyOn(f.worker, 'chat').mockImplementation(async (...args) => { await held.promise; return chat(...args); });
    f.worker.script(finish('after handoff', 'independent result'));
    const task = await f.spawn(); await vi.waitFor(() => expect(f.worker.chat).toHaveBeenCalled());
    expect(f.core.loop.requestContextHandoff()).toBe(true);
    await vi.waitFor(() => expect(f.core.loop.getStatus().lastTruncateAt).not.toBeNull());
    expect((await f.get(task.taskId)).status).toBe('running');
    const file = readdirSync(join(f.persona.memoryDir, 'handoffs')).find(name => name.endsWith('.md'))!;
    const path = 'handoffs/' + file;
    const read = f.persona.declareSessions().find(decl => decl.id === 'main')!.tools().find(tool => tool.name === 'read_file')!;
    expect(await read.handler({ path }, { role: 'subagent', log: nullLogger() })).toBe(readFileSync(join(f.persona.memoryDir, path), 'utf8'));
    const mainReceipt = await read.handler({ path }, { role: 'main', log: nullLogger() });
    expect(mainReceipt).toContain('已作为事件送入');
    expect(await read.handler({ path }, { role: 'dream', log: nullLogger() })).toBe(mainReceipt);
    held.release(); await f.idle();
    expect(await f.get(task.taskId)).toMatchObject({ status: 'complete', result: 'independent result' });
  });

  it('rejects long summaries, accepts Unicode characters and pages only full results', async () => {
    const f = await setup({ subagents: { maxSummaryChars: 2, resultPageChars: 2 } });
    f.worker.script(finish('😀好啊', 'discarded'), finish('😀好', '😀甲乙😀丁', 'partial'));
    const task = await f.spawn(); await f.idle();
    expect(f.worker.calls[1].messages.some(msg => msg.role === 'tool'
      && msg.content?.includes('━━━ 子代理收尾 ━━━\n状态：bad_input\n原因：Shorten summary'))).toBe(true);
    expect(await f.get(task.taskId)).toMatchObject({ status: 'partial', summary: '😀好', result: '😀甲', resultChars: 5, nextOffset: 2 });
    expect(await f.get(task.taskId, 2)).toMatchObject({ result: '乙😀', nextOffset: 4 });
    expect(await f.get(task.taskId, 4)).toMatchObject({ result: '丁', nextOffset: null });
    const result = await f.invokeTool('subagent_get', { taskId: task.taskId, maxChars: 1 });
    expect(result).toContain('━━━ 完整结果 ━━━\n结果长度：5 字符\n起始字符位置：0\n\n😀');
    expect(result).toContain('下一页：subagent_get(taskId="' + task.taskId + '", offsetChars=1, maxChars=1)');
    const last = await f.invokeTool('subagent_get', { taskId: task.taskId, offsetChars: 4 });
    expect(last).toContain('━━━ 完整结果 ━━━\n结果长度：5 字符\n起始字符位置：4\n\n丁');
    expect(last).toContain('━━━ 结果分页 ━━━\n已到完整结果末尾。');
    expect(await f.invokeTool('subagent_get', { taskId: 'unknown' })).toEqual({
      failed: true, text: '━━━ 子代理结果查询 ━━━\n状态：failed\n原因：Error: 未知任务 ID',
    });
    await expect(f.get('../../config')).rejects.toThrow('未知任务 ID');
    await expect(f.persona.subagentsInvoke('get', [{ taskId: task.taskId, maxChars: 3 }])).rejects.toThrow('分页范围');
  });

  it('accepts natural output and records model failures', async () => {
    const f = await setup();
    f.worker.script(textReply('A proposal to review')); const natural = await f.spawn(); await f.idle();
    expect(await f.get(natural.taskId)).toMatchObject({ status: 'complete', result: 'A proposal to review' });
    f.worker.throwNext = new Error('scripted model failure'); const failure = await f.spawn('failure'); await f.idle();
    expect(await f.get(failure.taskId)).toMatchObject({ status: 'failed' });
    expect((await f.get(failure.taskId)).result).toContain('scripted model failure');
  });

  it('retains startup round budgets and preserves capped output as partial', async () => {
    const f = await setup({ subagents: { softRounds: 1, maxRounds: 2 } }); const held = gate();
    const chat = f.worker.chat.bind(f.worker);
    vi.spyOn(f.worker, 'chat').mockImplementation(async (...args) => { await held.promise; return chat(...args); });
    f.worker.fallback = () => toolReply([{ name: 'list_files', args: {} }], 'unfinished work');
    const task = await f.spawn('long work', ['list_files']);
    await f.save({ 'subagents.maxRounds': 6, 'subagents.softRounds': 4 }); held.release(); await f.idle();
    expect(f.worker.calls).toHaveLength(2);
    expect(f.worker.calls[1].messages.some(msg => msg.role === 'tool' && msg.content?.includes('Used 1/2 model rounds'))).toBe(true);
    expect(await f.get(task.taskId)).toMatchObject({ status: 'partial', result: 'unfinished work', maxRounds: 2 });
  });
});

describe('live tool permissions', () => {
  it('defaults initial read tools on, requires an explicit task subset and preserves choices across group toggles', async () => {
    const { dir, world } = worldFixture(); const f = await setup({ dir, worlds: [world] });
    const group = f.persona.subagentsState().groups.find(group => group.id === world.id)!;
    expect(group.tools.find(tool => tool.name === 'files_read')?.allowed).toBe(true);
    expect(group.tools.find(tool => tool.name === 'files_write')?.allowed).toBe(false);
    expect(group.tools.find(tool => tool.name === 'files_send')?.reason).toBeUndefined();
    expect((await f.spawn('forbidden', ['files_write'])).accepted).toBe(false);
    const permissions = structuredClone(f.cfg.subagents!.permissions);
    permissions.files.tools.files_write = true; permissions.files.enabled = false;
    await f.save({ 'subagents.permissions': permissions });
    expect((await f.spawn('paused', ['files_read'])).accepted).toBe(false);
    expect(f.cfg.subagents!.permissions.files.tools.files_write).toBe(true);
    expect(f.core.isWorldVisible(world.id)).toBe(true);
    permissions.files.enabled = true; await f.save({ 'subagents.permissions': permissions });
    f.worker.script(toolReply([{ name: 'files_write', args: { text: 'authorized change' } }]), finish());
    const task = await f.spawn('write world', ['files_write']); await f.idle();
    expect(readFileSync(world.file, 'utf8')).toBe('authorized change'); expect((await f.get(task.taskId)).status).toBe('complete');
    expect(f.worker.calls[0].tools?.map(tool => tool.name)).toEqual(['files_write', 'subagent_finish', 'subagent_notify']);
  });

  it.each(['permission', 'unmount', 'hidden', 'shutdown'] as const)('blocks pending worker operations after %s', async reason => {
    const { dir, world } = worldFixture(); const f = await setup({ dir, worlds: [world] }); const held = gate();
    const permissions = structuredClone(f.cfg.subagents!.permissions); permissions.files.tools.files_write = true;
    await f.save({ 'subagents.permissions': permissions });
    const chat = f.worker.chat.bind(f.worker);
    vi.spyOn(f.worker, 'chat').mockImplementation(async (...args) => { await held.promise; return chat(...args); });
    f.worker.script(toolReply([{ name: 'files_write', args: { text: 'must not be written' } }]), finish());
    const task = await f.spawn('pending write', ['files_write']);
    await vi.waitFor(() => expect(f.worker.chat).toHaveBeenCalled());
    if (reason === 'permission') { permissions.files.enabled = false; await f.save({ 'subagents.permissions': permissions }); }
    if (reason === 'unmount') await f.core.unmountWorld(world.id);
    if (reason === 'hidden') f.core.setWorldVisible(world.id, false);
    if (reason === 'shutdown') f.core.loop.stop();
    held.release(); await f.idle();
    expect(readFileSync(world.file, 'utf8')).toBe('original');
    if (reason === 'shutdown') expect((await f.get(task.taskId)).status).toBe('interrupted');
    else expect(f.worker.calls[1].messages.some(msg => msg.role === 'tool' && msg.content?.includes('permission denied'))).toBe(true);
  });

  it('discovers new extension tools disabled and uses current handlers for mounted tools', async () => {
    const { dir, world } = worldFixture(); const f = await setup({ dir, worlds: [world] });
    world.defs.push({ name: 'files_new_read', description: 'A new read tool.', tags: ['read'], parameters: {}, handler: async () => 'new' });
    await f.core.loop.reloadSystemPrefix();
    expect(f.persona.subagentsState().groups.find(group => group.id === world.id)!.tools.find(tool => tool.name === 'files_new_read')?.allowed).toBe(false);
    expect((await f.spawn('new tool', ['files_new_read'])).accepted).toBe(false);
    const held = gate(); const chat = f.worker.chat.bind(f.worker);
    vi.spyOn(f.worker, 'chat').mockImplementation(async (...args) => { await held.promise; return chat(...args); });
    f.worker.script(toolReply([{ name: 'files_read' }]), finish());
    await f.spawn('current handler', ['files_read']);
    await vi.waitFor(() => expect(f.worker.chat).toHaveBeenCalled());
    world.defs[0] = { ...world.defs[0], handler: async () => 'current handler output' };
    held.release(); await f.idle();
    expect(f.worker.calls[1].messages.some(msg => msg.role === 'tool' && msg.content === 'current handler output')).toBe(true);
    expect(JSON.parse(readFileSync(join(f.dir, 'config.json'), 'utf8')).subagents.permissions.files.tools.files_new_read).toBe(false);
  });

  it('ends an explicitly confirmed task before later calls in the same reply can change the World', async () => {
    const { dir, world } = worldFixture(); const f = await setup({ dir, worlds: [world] });
    const permissions = structuredClone(f.cfg.subagents!.permissions); permissions.files.tools.files_write = true;
    await f.save({ 'subagents.permissions': permissions });
    f.worker.script(toolReply([
      { name: 'subagent_finish', args: { status: 'complete', summary: 'confirmed', result: 'proposal' } },
      { name: 'files_write', args: { text: 'late operation' } },
    ]));
    const task = await f.spawn('confirm and stop', ['files_write']); await f.idle();
    expect((await f.get(task.taskId)).status).toBe('complete'); expect(readFileSync(world.file, 'utf8')).toBe('original');
  });

  it('permits selected World sending tools while barring Memory mutation', async () => {
    const { dir, world } = worldFixture(); const f = await setup({ dir, worlds: [world] });
    const permissions = structuredClone(f.cfg.subagents!.permissions);
    permissions.memory.tools.write_file = true;
    await expect(f.save({ 'subagents.permissions': permissions })).rejects.toThrow('Memory 只读');
    permissions.memory.tools.write_file = false; permissions.files.tools.files_send = true;
    await f.save({ 'subagents.permissions': permissions });
    const path = join(f.persona.memoryDir, 'note', 'sample.md'); writeFileSync(path, 'current content');
    const mainTools = f.persona.declareSessions().find(decl => decl.id === 'main')!.tools();
    for (const [name, args] of [
      ['write_file', { path: 'note/sample.md', content: 'changed' }],
      ['append_file', { path: 'note/sample.md', content: 'changed' }],
      ['edit_file', { path: 'note/sample.md', old_string: 'current', new_string: 'changed' }],
      ['delete_file', { path: 'note/sample.md' }],
      ['move_file', { from: 'note/sample.md', to: 'note/moved.md' }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(await mainTools.find(tool => tool.name === name)!.handler(args, { role: 'subagent', log: nullLogger() })).toContain('read-only');
    }
    expect(readFileSync(path, 'utf8')).toBe('current content');
  });

  it('saves permissions immediately while retaining the current main prefix until manual reload', async () => {
    const f = await setup(); const before = itemText(f.core.session.records[0].item);
    expect(before).toContain('4');
    f.core.session.append(message('user', 'retained main conversation'));
    await f.save({ 'subagents.maxWorkers': 2 });
    expect(itemText(f.core.session.records[0].item)).toBe(before);
    expect(f.cfg.subagents!.maxWorkers).toBe(2);
    await f.core.loop.reloadSystemPrefix();
    expect(itemText(f.core.session.records[0].item)).not.toBe(before);
    expect(f.core.session.records.map(record => itemText(record.item)).join('')).toContain('retained main conversation');
    const stale = f.persona.subagentsState(); await f.save({ 'subagents.maxWorkers': 3 });
    await expect(f.persona.subagentsInvoke('saveDraft', [stale.values, stale.revision])).rejects.toThrow('重新加载');
  });
});

describe('task storage and configuration', () => {
  it('restores results and interrupts unfinished records without rerunning them', async () => {
    const f = await setup(); f.worker.script(finish('stored', 'stored result'));
    const done = await f.spawn(); await f.idle();
    const store = new TaskStore(join(f.dir, 'data', 'continuity', 'subagents'));
    const running: TaskRecord = { id: randomUUID(), task: 'interrupted task', materials: [], tools: [], status: 'running',
      startedAt: '2026-10-01T00:00:00Z', summary: '', resultChars: 0, softRounds: 8, maxRounds: 16,
      source: 'main', context: 'isolated', timeoutMs: 900000, contextTokens: 100000, rounds: 0, peakInputTokens: null, estimatedInputTokens: 0, reminders: [] };
    store.writeResult(running, 'already produced text');
    const restarted = new ContinuityPersona({ memoryDir: f.persona.memoryDir, deploymentDir: f.dir, cfg: composeDefaults() });
    expect(restarted.subagentsState().running).toBe(0);
    expect(await restarted.subagentsInvoke('get', [{ taskId: running.id }])).toMatchObject({ status: 'interrupted', result: 'already produced text' });
    expect(await restarted.subagentsInvoke('get', [{ taskId: done.taskId }])).toMatchObject({ status: 'complete', result: 'stored result' });
    expect(restarted.subagentsState().records[0].id).toBe(done.taskId);
    expect(f.worker.calls).toHaveLength(1); restarted.dispose();
  });

  it('validates declared budgets and permission switch shapes', () => {
    expect(subagentsConfig()).toEqual(SUBAGENTS_DEFAULTS);
    expect(() => validateSubagentsDraft({ 'subagents.maxWorkers': 0 }, subagentsConfig())).toThrow();
    expect(() => validateSubagentsDraft({ 'subagents.softRounds': SUBAGENTS_DEFAULTS.maxRounds }, subagentsConfig())).toThrow('小于');
    expect(() => validateSubagentsDraft({ 'subagents.extra': 1 }, subagentsConfig())).toThrow('未知配置项');
    expect(() => validateSubagentsDraft({ 'subagents.permissions': { memory: { enabled: true, tools: { read_file: 'yes' } } } }, subagentsConfig())).toThrow('开关值');
  });

  it('rejects a persisted record whose ID would resolve outside its own directory', async () => {
    const f = await setup(); const dir = join(f.dir, 'records'); mkdirSync(dir);
    writeFileSync(join(dir, randomUUID() + '.json'), JSON.stringify({ id: '../config', status: 'complete' }));
    expect(() => new TaskStore(dir)).toThrow('ID does not match');
  });
});

describe('World cognition and task controls', () => {
  it('shares capacity and permits only the requesting World plus enabled Memory reads, including hidden Worlds', async () => {
    const { dir, world } = worldFixture(); const f = await setup({ dir, worlds: [world], subagents: { maxWorkers: 1 } });
    expect(await world.host.cognition!.request({ brief: 'forbidden', tools: ['read_file'] })).toHaveProperty('error');
    f.core.setWorldVisible(world.id, false);
    f.worker.blockUntilAbort = true;
    const pending = world.host.cognition!.request({ brief: 'background read', tools: ['files_send'] });
    await vi.waitFor(() => expect(f.worker.calls).toHaveLength(1));
    const schema = f.worker.calls[0].tools!.map(tool => tool.name);
    expect(schema).toEqual(expect.arrayContaining(['files_send', 'read_file', 'subagent_notify']));
    expect(schema).not.toContain('files_write'); expect(schema).not.toContain('write_file');
    expect((await f.spawn('overflow')).reason).toContain('capacity');
    const record = f.persona.subagentsState().records[0];
    expect(record).toMatchObject({ source: 'world', worldId: 'files', context: 'main' });
    await f.invokeTool('subagent_spawn', { mode: 'cancel', taskId: record.id });
    expect(await pending).toHaveProperty('error'); await f.idle();
    expect(await f.get(record.id)).toMatchObject({ status: 'cancelled', endReason: 'cancelled' });
  });

  it('captures main context at acceptance and excludes an unfinished tool response', async () => {
    const f = await setup();
    f.core.session.append(message('user', 'earlier main fact'));
    const generator = new FakeLLM(); generator.script(toolReply([{ name: 'subagent_spawn' }], 'unfinished main action'));
    const generated = await generator.respond({ model: 'fixture', input: [] });
    const incomplete = responseRecords(generated.response, generated.origin);
    for (const entry of incomplete) f.core.session.append(entry);
    f.worker.script(textReply('captured'));
    const accepted = await f.persona.subagentsInvoke('spawn', [{ task: 'snapshot', materials: [], tools: [], context: 'main' }]) as { taskId: string };
    f.core.session.append(message('user', 'later main fact'));
    await f.idle();
    const input = f.worker.calls[0].messages.map(msg => msg.content).join('\n');
    expect(input).toContain('earlier main fact'); expect(input).not.toContain('unfinished main action'); expect(input).not.toContain('later main fact');
    expect(await f.get(accepted.taskId)).toMatchObject({ context: 'main', status: 'complete' });
    const call = generated.response.output.find(item => item.type === 'function_call')!;
    const paired = [...incomplete, functionResult(call.call_id, 'paired')];
    expect(balancedSnapshot(paired)).toHaveLength(paired.length);
  });

  it('treats a World hint as advice and reports actual rounds and metered peak input', async () => {
    const { dir, world } = worldFixture(); const f = await setup({ dir, worlds: [world] });
    f.worker.usage = { promptTokens: 1200, completionTokens: 20, cacheHitTokens: 0, cacheMissTokens: 1200 };
    f.worker.script(...Array.from({ length: 9 }, () => toolReply([{ name: 'files_read' }])), textReply('design ready'));
    expect(await world.host.cognition!.request({ brief: 'complex design', tools: ['files_read'], hint: { rounds: 8 } })).toEqual({ text: 'design ready' });
    await f.idle();
    expect(f.persona.subagentsState().records[0]).toMatchObject({ rounds: 10, hintRounds: 8, maxRounds: SUBAGENTS_DEFAULTS.maxRounds, peakInputTokens: 1200 });
  });

  it('continues past the soft reminder and stops exactly at the hard round limit', async () => {
    const f = await setup(); f.worker.fallback = () => toolReply([{ name: 'list_files', args: {} }], 'retained work');
    const task = await f.spawn('large task', ['list_files']); await f.idle();
    expect(f.worker.calls).toHaveLength(SUBAGENTS_DEFAULTS.maxRounds);
    expect(f.worker.calls[SUBAGENTS_DEFAULTS.softRounds].messages.some(msg => msg.content?.includes('Tools remain available.'))).toBe(true);
    expect(await f.get(task.taskId)).toMatchObject({ status: 'partial', endReason: 'round_limit', result: 'retained work' });
  });

  it('persists reminder evidence before delivery, continues work and never repeats it on completion or restart', async () => {
    const { dir, world } = worldFixture(); const f = await setup({ dir, worlds: [world] });
    const memoryFile = join(f.persona.memoryDir, 'note', 'state.md'); writeFileSync(memoryFile, 'original Memory');
    const held = gate(); const chat = f.worker.chat.bind(f.worker); let requests = 0;
    vi.spyOn(f.worker, 'chat').mockImplementation(async (...args) => { if (++requests === 2) await held.promise; return chat(...args); });
    f.worker.script(toolReply([{ name: 'subagent_notify', args: { summary: 'Semantic state changed', details: 'Read note/state.md; verified World now says new state.' } }]), textReply('finished'));
    const pending = world.host.cognition!.request({ brief: 'reconcile state' });
    await vi.waitFor(() => expect(f.core.store.range({ origin: 'internal' }).filter(event => event.type === 'continuity.subagent.reminder')).toHaveLength(1));
    const record = f.persona.subagentsState().records[0];
    expect(record.status).toBe('running'); expect(record.reminders).toHaveLength(1);
    expect(readFileSync(join(dir, 'data', 'continuity', 'subagents', record.id + '.reminder-1.txt'), 'utf8')).toContain('verified World');
    expect(await f.persona.subagentsInvoke('get', [{ taskId: record.id, reminderIndex: 1, maxChars: 4 }])).toMatchObject({ result: 'Read', nextOffset: 4 });
    expect(readFileSync(memoryFile, 'utf8')).toBe('original Memory');
    held.release(); await pending; await f.idle();
    const restored = new TaskStore(join(dir, 'data', 'continuity', 'subagents'));
    expect(restored.get(record.id)?.reminders).toHaveLength(1);
    expect(f.core.store.range({ origin: 'internal' }).filter(event => event.type === 'continuity.subagent.reminder')).toHaveLength(1);
  });

  it('does not announce evidence when its file cannot be saved', async () => {
    const f = await setup(); const held = gate(); const chat = f.worker.chat.bind(f.worker);
    vi.spyOn(f.worker, 'chat').mockImplementation(async (...args) => { await held.promise; return chat(...args); });
    f.worker.script(toolReply([{ name: 'subagent_notify', args: { summary: 'notice', details: 'evidence' } }]), textReply('recovered'));
    const task = await f.spawn();
    mkdirSync(join(f.dir, 'data', 'continuity', 'subagents', task.taskId + '.reminder-1.txt.tmp'));
    held.release(); await f.idle();
    expect(f.core.store.range({ origin: 'internal' }).filter(event => event.type === 'continuity.subagent.reminder')).toHaveLength(0);
    expect((await f.persona.subagentsInvoke('get', [{ taskId: task.taskId }]))).toMatchObject({ reminders: [], status: 'complete' });
  });

  it.each(['cancel', 'timeout', 'disable', 'world-disable', 'lifecycle'] as const)('settles %s while an uncooperative tool retains its slot, and discards late output', async mode => {
    const { dir, world } = worldFixture(); const held = gate(); let signal: AbortSignal | undefined;
    world.defs[0] = { ...world.defs[0], handler: async (_args, ctx) => { signal = ctx.signal; await held.promise; return 'late data'; } };
    const f = await setup({ dir, worlds: [world], subagents: { maxWorkers: 1, timeoutMs: mode === 'timeout' ? 150 : 900000 } });
    f.worker.script(toolReply([{ name: 'files_read' }], 'before stop'), textReply('must never run'));
    const pending = world.host.cognition!.request({ brief: 'held tool', tools: ['files_read'] });
    await vi.waitFor(() => expect(signal).toBeDefined()); const record = f.persona.subagentsState().records[0];
    if (mode === 'cancel') await f.invokeTool('subagent_spawn', { mode: 'cancel', taskId: record.id });
    if (mode === 'disable') await f.save({ 'subagents.enabled': false });
    if (mode === 'world-disable') await f.save({ 'subagents.cognitionPermissions': { files: { enabled: false, tools: {} } } });
    if (mode === 'lifecycle') f.persona.onWorldLifecycle({ kind: 'restarted', id: 'files', label: 'Files' });
    expect(await pending).toHaveProperty('error'); expect(signal!.aborted).toBe(true);
    expect(f.persona.subagentsState()).toMatchObject({ running: 1, records: [expect.objectContaining({ status: 'stopping' })] });
    held.release(); await f.idle();
    expect(f.worker.calls).toHaveLength(1);
    expect(await f.get(record.id)).toMatchObject({ status: mode === 'cancel' ? 'cancelled' : mode === 'timeout' ? 'timed_out' : 'interrupted', result: 'before stop' });
  });

  it('rechecks World tool permissions and accepts untagged tools selected by the main agent', async () => {
    const { dir, world } = worldFixture(); world.defs[1].tags = [];
    const f = await setup({ dir, worlds: [world] }); const held = gate(); const chat = f.worker.chat.bind(f.worker);
    const permissions = structuredClone(f.cfg.subagents!.permissions); permissions.files.tools.files_write = true;
    await f.save({ 'subagents.permissions': permissions });
    f.worker.script(toolReply([{ name: 'files_write', args: { text: 'visible untagged write' } }]), textReply('done'));
    expect((await f.spawn('untagged', ['files_write'])).accepted).toBe(true); await f.idle();
    expect(readFileSync(world.file, 'utf8')).toBe('visible untagged write');
    vi.spyOn(f.worker, 'chat').mockImplementation(async (...args) => { await held.promise; return chat(...args); });
    f.worker.script(toolReply([{ name: 'files_write', args: { text: 'forbidden' } }]), textReply('denial handled'));
    const pending = world.host.cognition!.request({ brief: 'live permissions', tools: ['files_write'] });
    await f.save({ 'subagents.cognitionPermissions': { files: { enabled: true, tools: { files_write: false } } } });
    held.release(); expect(await pending).toEqual({ text: 'denial handled' }); await f.idle();
    expect(readFileSync(world.file, 'utf8')).toBe('visible untagged write');
    expect(await world.host.cognition!.request({ brief: 'denied at start', tools: ['files_write'] })).toHaveProperty('error');
  });

  it('prunes closed temporary sessions while retaining task results', async () => {
    const f = await setup(); const ids: string[] = [];
    for (let i = 0; i < 10; i++) { f.worker.script(textReply('result ' + i)); ids.push((await f.spawn()).taskId); await f.idle(); }
    expect(f.core.sessions.list().filter(session => session.role === 'subagent')).toHaveLength(8);
    expect((await f.get(ids[0])).result).toBe('result 0');
  });
});

describe('native worker limits and tool receipts', () => {
  it('warns at 80% once without restricting tools and stops before an oversized request', async () => {
    const f = await setup(); const tools: ToolDef[] = [{ name: 'read', description: '', parameters: {}, tags: ['read'], handler: async () => 'small receipt' }];
    f.worker.script(toolReply([{ name: 'read' }]), textReply('done'));
    const run = (content: string, contextTokens: number) => runWorker({ core: f.core, llm: f.worker, spec: f.core.activeSpec(), log: nullLogger(),
      messages: [message('user', content)], tools, maxRounds: 4, softRounds: 2, contextTokens, signal: new AbortController().signal, label: 'fixture',
      stopped: () => false, finished: () => false, progress: () => {} });
    expect(await run('a'.repeat(10000), 3500)).toMatchObject({ reason: 'natural', text: 'done' });
    expect(f.worker.calls[1].messages.filter(msg => msg.content?.includes('80% warning'))).toHaveLength(1);
    expect(await run('initially oversized', 1)).toMatchObject({ reason: 'context_limit', text: '' });
    expect(f.worker.calls).toHaveLength(2);
  });

  it('stops after a tool result crosses the context limit, preserving last text without a summary request', async () => {
    const f = await setup(); f.cfg.context.maxTokens = 8000;
    const material = 'large'.repeat(10000); writeFileSync(join(f.persona.memoryDir, 'note', 'large.txt'), material);
    f.worker.script(toolReply([{ name: 'read_file', args: { path: 'note/large.txt' } }], 'last useful text'));
    const task = await f.spawn('read file', ['read_file']); await f.idle();
    expect(f.worker.calls).toHaveLength(1); expect(await f.get(task.taskId)).toMatchObject({ status: 'partial', endReason: 'context_limit', result: 'last useful text' });
  });

  it('classifies provider context overflow without retrying and accepts corrected finish arguments', async () => {
    const f = await setup(); f.worker.throwNext = new Error('context_length_exceeded');
    const tooLarge = await f.spawn(); await f.idle(); expect(await f.get(tooLarge.taskId)).toMatchObject({ status: 'failed', endReason: 'context_limit' });
    f.worker.script(finish('empty', ''), finish('bad failure', '', 'failed'));
    const corrected = await f.spawn(); await f.idle();
    expect(await f.get(corrected.taskId)).toMatchObject({ status: 'failed', summary: 'bad failure', endReason: 'finish' });
    expect(f.worker.calls).toHaveLength(3);
  });

  it('preserves blobs and failed outcomes, pairs skipped calls after a barrier and respects endsTurn', async () => {
    const { dir, world } = worldFixture(); const f = await setup({ dir, worlds: [world] });
    world.defs[0] = { ...world.defs[0], barrierAfter: true, handler: async () => ({ text: 'inspect image', failed: true,
      blobs: [{ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', fallbackText: 'image evidence' }] }) };
    const seen: Array<readonly import('cortico/protocol/open-responses/context.ts').ContextRecord[]> = [];
    const respond = f.worker.respond.bind(f.worker);
    vi.spyOn(f.worker, 'respond').mockImplementation((request, options) => { seen.push(structuredClone(options!.context!)); return respond(request, options); });
    f.worker.script(toolReply([{ name: 'files_read' }, { name: 'files_send' }]), textReply('recovered'));
    expect(await world.host.cognition!.request({ brief: 'media task', tools: ['files_read', 'files_send'] })).toEqual({ text: 'recovered' }); await f.idle();
    const receipts = seen[1].filter(entry => entry.item.type === 'function_call_output');
    expect(receipts[0].context.blobs).toHaveLength(1); expect(itemText(receipts[0].item)).toContain('[failed]'); expect(itemText(receipts[0].item)).toContain('image evidence');
    expect(itemText(receipts[1].item)).toContain('not executed');
    world.defs[0] = { ...world.defs[0], barrierAfter: false, endsTurn: true, handler: async () => 'ended' };
    f.worker.script(toolReply([{ name: 'files_read' }], 'partial text'));
    expect(await world.host.cognition!.request({ brief: 'end turn', tools: ['files_read'] })).toEqual({ text: '[partial: ends_turn]\npartial text' });
  });
});

describe('L4 World compatibility', () => {
  it('accepts cognition during World startup before the main loop begins', async () => {
    const { dir, world } = worldFixture(); let result: unknown;
    const start = world.start.bind(world);
    world.start = async host => { await start(host); result = await host.cognition!.request({ brief: 'startup thought' }); };
    const f = await setup({ dir, worlds: [world], workerSetup: worker => worker.script(textReply('ready')) });
    expect(result).toEqual({ text: 'ready' });
    expect(f.worker.calls[0].messages.map(msg => msg.content).join('\n')).toContain('ORIENTATION');
  });
  it('completes the real Minecraft blueprint design contract with batched saves and a correction', async () => {
    const { MinecraftWorld } = await import('cortico/worlds/minecraft/world.ts');
    const { MINECRAFT_DEFAULTS } = await import('cortico/worlds/minecraft/config.ts');
    const dir = mkdtempSync(join(tmpdir(), 'continuity-subagents-'));
    const minecraft = new MinecraftWorld({ cfg: structuredClone(MINECRAFT_DEFAULTS), dataDir: dir });
    // Attach real tools to a local host without connecting a game engine.
    const world: World = { id: 'minecraft', tools: () => minecraft.tools(), envPromptVars: () => null,
      start: async host => { Object.assign(minecraft, { host }); }, stop: async () => { await minecraft.stop(); } };
    const f = await setup({ dir, worlds: [world] });
    let round = 0;
    f.worker.fallback = () => {
      round++;
      const input = f.worker.calls.at(-1)!.messages.map(msg => msg.content).join('\n');
      const jobId = input.match(/job_id 是「([^」]+)」/)?.[1];
      if (round === 1) return toolReply([{ name: 'mc_blueprint', args: { save: { key: 'fixture-tower', job_id: jobId, size_xyz: [0, 2, 1] } } }]);
      if (round <= 3) return toolReply([{ name: 'mc_blueprint', args: { save: {
        key: 'fixture-tower', job_id: jobId, site_mode: 'new', size_xyz: [1, 2, 1], axis_order: 'YZX',
        palette: ['minecraft:cobblestone', 'minecraft:oak_planks'], layers: [[[round === 2 ? 0 : 1]]], append: round === 3,
      } } }]);
      return textReply('我已完成两层设计。');
    };
    const tool = minecraft.tools().find(tool => tool.name === 'mc_blueprint')!;
    expect(await tool.handler({ design: { key: 'fixture-tower', brief: '两层结构' } }, { role: 'main', log: nullLogger() })).toContain('构思在后台开工');
    await f.idle();
    await vi.waitFor(() => expect(f.core.store.range({ source: 'minecraft' }).some(event => event.text?.includes('图已经装载好'))).toBe(true));
    expect(JSON.parse(readFileSync(join(dir, 'minecraft-blueprints.json'), 'utf8')).designs[0]).toMatchObject({ key: 'fixture-tower' });
    expect(f.persona.subagentsState().records[0]).toMatchObject({ source: 'world', worldId: 'minecraft', status: 'complete', rounds: 4 });
    expect(f.worker.calls[0].tools!.map(tool => tool.name)).not.toContain('write_file');
  });

  it('restores optional PWSR state from Memory through World tools and verifies it without writing Memory', async () => {
    const { PwsrTables } = await import('cortico/worlds/minecraft/world.ts');
    const { dir, world } = worldFixture(); const tables = new PwsrTables();
    const current = tables.register({ key: 'goals', create: () => [] as string[], cleared: list => list.length ? list.length + ' goals' : null,
      status: list => list.join(', ') || 'empty', hint: 'files_load' });
    world.defs = [
      { name: 'files_load', description: 'Restore selected semantic records.', parameters: {}, tags: ['write'], handler: async args => { current().push(String(args.goal)); return 'loaded; verified in current realm'; } },
      { name: 'files_state', description: 'Read runtime state; empty is allowed.', parameters: {}, tags: ['read'], handler: async () => tables.statusLine()! },
    ];
    const f = await setup({ dir, worlds: [world] }); const file = join(f.persona.memoryDir, 'note', 'goals.txt'); writeFileSync(file, 'restore bridge');
    f.worker.script(toolReply([{ name: 'files_state' }]), toolReply([{ name: 'read_file', args: { path: 'note/goals.txt' } }]),
      toolReply([{ name: 'files_load', args: { goal: 'restore bridge' } }]), toolReply([{ name: 'files_state' }]), textReply('Restored and verified.'));
    expect(await world.host.cognition!.request({ brief: 'Reconcile optional World state', tools: ['files_load', 'files_state'] })).toEqual({ text: 'Restored and verified.' });
    expect(current()).toEqual(['restore bridge']); expect(readFileSync(file, 'utf8')).toBe('restore bridge');
    expect(f.worker.calls[1].messages.some(msg => msg.content?.includes('empty'))).toBe(true);
    expect(f.worker.calls[4].messages.some(msg => msg.role === 'tool' && msg.content?.includes('restore bridge'))).toBe(true);
  });

  it('keeps main output streaming and stall reporting available to realtime Worlds', async () => {
    const { dir, world } = worldFixture(); const events: string[] = [];
    const tap: OutputTap = { onEvent: event => { events.push(event.type); }, externalizes: () => false };
    const realtime: World = { ...world, id: world.id, tools: () => world.tools(), envPromptVars: () => null,
      start: host => world.start(host), stop: () => world.stop(), outputTap: () => tap };
    const f = await setup({ dir, worlds: [realtime] });
    events.length = 0; f.main.script(textReply('live main output'));
    world.host.pushEvent({ type: 'files.request', source: 'files', text: 'respond', ts: new Date().toISOString() }, { trigger: 'flush' });
    await vi.waitFor(() => expect(events).toContain('response.output_text.delta'));
    expect(await world.host.llmStalls!(60000)).toBe(0);
    f.main.throwNext = new Error('fixture interrupted stream');
    world.host.pushEvent({ type: 'files.request', source: 'files', text: 'second response', ts: new Date().toISOString() }, { trigger: 'flush' });
    await vi.waitFor(async () => expect(await world.host.llmStalls!(60000)).toBeGreaterThan(0));
  });
});
