import { expect, it } from 'vitest';
import { Appraiser } from '../persona/appraisal.ts';
import { composeDefaults } from '../index.ts';
import { reviewPrivacy } from '../persona/review-privacy.ts';

it('redacts the final remote action, context and questions consistently while preserving read lengths', async () => {
  const cfg = composeDefaults().appraisal!; cfg.provider = 'jev'; cfg.jev.allowRemoteText = true;
  let sent: { state: { message: string }; questions: Record<string, unknown> } | undefined;
  const appraiser = new Appraiser(cfg, { getEnv: () => 'fixture-key', requestJev: async request => {
    sent = request; return { answers: { rule0: { choice: 'allow' } } };
  } });
  try {
    const result = await appraiser.reviewAction({ tool: 'read_file', args: { path: 'people/Alice.md' },
      read: { chars: 12000, lines: 1500, limit: 10000 }, context: { scene: 'chat:group:87654321',
        recentDialogue: [{ speaker: 'Alice', text: 'Alice shared https://private.test/a and alice@example.test.' }] } },
    [{ id: 'read-budget', scope: { sessions: ['main', 'dream'], tags: ['write' as const, 'speak' as const, 'act' as const] }, instruction: 'For Alice, read fewer than 10000 characters.', exceptions: 'Contact alice@example.test if needed.' }]);
    expect(result).toMatchObject({ kind: 'reviewed' });
    const payload = JSON.parse(sent!.state.message);
    expect(payload.action.read).toEqual({ chars: 12000, lines: 1500, limit: 10000 });
    const wire = JSON.stringify(sent!.questions) + sent!.state.message;
    for (const original of ['Alice', '87654321', 'alice@example.test', 'private.test', 'fixture-key']) expect(wire).not.toContain(original);
    const participant = payload.action.context.recentDialogue[0].speaker;
    expect(payload.action.args.path).toContain(participant);
    expect(JSON.stringify(sent!.questions)).toContain(participant);
  } finally { await appraiser.dispose(); }
});

it('does not send credentials in action fields or text', async () => {
  const cfg = composeDefaults().appraisal!; cfg.provider = 'jev'; cfg.jev.allowRemoteText = true;
  let calls = 0;
  const appraiser = new Appraiser(cfg, { getEnv: () => 'fixture-key', requestJev: async () => { calls++; throw new Error('unexpected request'); } });
  const rules = [{ id: 'private', scope: { sessions: ['main', 'dream'], tags: ['write' as const, 'speak' as const, 'act' as const] }, instruction: 'Use necessary information only.', exceptions: '' }];
  try {
    expect(await appraiser.reviewAction({ tool: 'send', args: { authorization: 'Bearer a-private-credential' } }, rules)).toMatchObject({ kind: 'insufficient' });
    expect(await appraiser.reviewAction({ tool: 'send', args: { token: 'private-credential' } }, rules)).toMatchObject({ kind: 'insufficient' });
    expect(await appraiser.reviewAction({ tool: 'send', args: { text: 'password=private-credential' } }, rules)).toMatchObject({ kind: 'insufficient' });
    expect(await appraiser.reviewAction({ tool: 'write_file', args: { content: JSON.stringify({ password: 'private-credential' }) } }, rules)).toMatchObject({ kind: 'insufficient' });
    expect(await appraiser.reviewAction({ tool: 'send', args: { text: 'Authorization: Basic private-credential' } }, rules)).toMatchObject({ kind: 'insufficient' });
    expect(await appraiser.reviewAction({ tool: 'write_file', args: { content: JSON.stringify({ access_token: 'private-credential' }) } }, rules)).toMatchObject({ kind: 'insufficient' });
    expect(await appraiser.reviewAction({ tool: 'send', args: { text: 'refresh_token=private-credential' } }, rules)).toMatchObject({ kind: 'insufficient' });
    cfg.jev.allowRemoteText = false;
    expect(await appraiser.reviewAction({}, rules)).toMatchObject({ kind: 'unavailable' }); expect(calls).toBe(0);
  } finally { await appraiser.dispose(); }
});

it('redacts people names in move paths and before-content keys without corrupting words containing a short speaker name', () => {
  const original = { action: { tool: 'move_file', args: { from: 'people/Alice.md', to: 'people/archived/Alice.md' },
    before: { 'people/Alice.md': 'Alice profile' }, context: { speaker: 'a', text: 'Save data for Alice and a.' } },
  constraints: [{ instruction: 'Save data for Alice.' }] };
  const privacy = reviewPrivacy(); privacy.prepare(original); const cleaned = privacy.clean(original) as typeof original;
  expect(JSON.stringify(cleaned)).not.toContain('Alice');
  expect(cleaned.action.args.from).toMatch(/^people\/\[person\d+\]\.md$/u);
  expect(cleaned.action.args.to).toMatch(/^people\/archived\/\[person\d+\]\.md$/u);
  expect(cleaned.action.context.text).toContain('Save data'); expect(cleaned.constraints[0].instruction).toContain('Save data');
  expect(cleaned.action.context.text).toContain(cleaned.action.context.speaker);
  expect(privacy.incomplete).toBe(false);
});

it('returns a safe failure category instead of remote error text', async () => {
  const cfg = composeDefaults().appraisal!; cfg.provider = 'jev'; cfg.jev.allowRemoteText = true;
  const appraiser = new Appraiser(cfg, { getEnv: () => 'fixture-key', requestJev: async () => { throw new Error('Bearer private-value and copied payload'); } });
  try {
    const result = await appraiser.reviewAction({ tool: 'send' }, [{ id: 'r', scope: { sessions: ['main', 'dream'], tags: ['write' as const, 'speak' as const, 'act' as const] }, instruction: 'Be concise.', exceptions: '' }]);
    expect(result).toMatchObject({ kind: 'unavailable' }); expect(JSON.stringify(result)).not.toContain('private-value');
  } finally { await appraiser.dispose(); }
});

it('sends normal dates, production message timestamps and redacted numeric identifiers to the decision service', async () => {
  const cfg = composeDefaults().appraisal!; cfg.provider = 'jev'; cfg.jev.allowRemoteText = true;
  const requests: string[] = [];
  const appraiser = new Appraiser(cfg, { getEnv: () => 'fixture-key', requestJev: async request => {
    requests.push(request.state.message); return { answers: { rule0: { choice: 'allow' } } };
  } });
  try {
    const rules = [{ id: 'dates', scope: { sessions: ['main', 'dream'], tags: ['write' as const, 'speak' as const, 'act' as const] }, instruction: 'Keep useful dates; omit processing metadata.', exceptions: '' }];
    expect(await appraiser.reviewAction({ tool: 'qq_draft', args: { to: 'group:123456', text: 'Deadline: 2026-10-24.' },
      context: { scene: 'qq:group:123456', recentDialogue: [{ ts: '2026-10-24T01:20:30Z', source: 'qq', type: 'qq.message', speaker: 'Alice', role: 'external', text: 'Please retain the deadline.' }] } }, rules)).toMatchObject({ kind: 'reviewed' });
    expect(await appraiser.reviewAction({ tool: 'write_file', args: { path: 'note/date.md', content: 'Updated 2026-10-24; record 123456.' } }, rules)).toMatchObject({ kind: 'reviewed' });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain('2026-10-24'); expect(requests[1]).toContain('2026-10-24');
    expect(requests.join('\n')).not.toContain('123456');
  } finally { await appraiser.dispose(); }
});

it('gives the same remote alias to alternate scene and replied-message spellings', () => {
  const input = { action: { tool: 'qq_draft', args: { to: 'group:123456', reply_to: '#987' },
    context: { scene: 'qq:group:123456', recentDialogue: [{ messageId: '987', text: 'Reply to #987.' }] } } };
  const privacy = reviewPrivacy(); privacy.prepare(input);
  const clean = privacy.clean(input) as typeof input;
  expect(clean.action.args.to).toBe(clean.action.context.scene);
  expect(clean.action.args.reply_to).toBe(clean.action.context.recentDialogue[0].messageId);
});

it('omits optional history containing credentials while preserving a reviewable current action', async () => {
  const cfg = composeDefaults().appraisal!; cfg.provider = 'jev'; cfg.jev.allowRemoteText = true;
  let wire = '';
  const appraiser = new Appraiser(cfg, { getEnv: () => 'fixture-key', requestJev: async request => {
    wire = request.state.message; return { answers: { rule0: { choice: 'allow' } } };
  } });
  try {
    expect(await appraiser.reviewAction({ tool: 'chat_send', args: { text: 'Hello.' } },
      [{ id: 'r', scope: { sessions: ['main', 'dream'], tags: ['write' as const, 'speak' as const, 'act' as const] }, instruction: 'Be concise.', exceptions: '' }],
      [{ text: 'Cookie: first=credential; second=private-value' }])).toMatchObject({ kind: 'reviewed' });
    expect(JSON.parse(wire)).toMatchObject({ history: [], omittedHistory: true });
    expect(wire).not.toContain('private-value');
  } finally { await appraiser.dispose(); }
});
