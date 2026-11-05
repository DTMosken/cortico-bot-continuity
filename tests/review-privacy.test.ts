import { expect, it } from 'vitest';
import { Appraiser } from '../persona/appraisal.ts';
import { composeDefaults } from '../index.ts';
import { replaceEmails, reviewPrivacy } from '../persona/review-privacy.ts';

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

const scan = (value: unknown) => {
  const privacy = reviewPrivacy(); privacy.prepare(value);
  return { wire: JSON.stringify(privacy.clean(value)), incomplete: privacy.incomplete };
};
const fake = (prefix: string, length = 36) => prefix + 'Ab1'.repeat(length).slice(0, length);

it.each([
  ['env-style names', { tool: 'write_file', args: { content: 'OPENAI_API_KEY=sk-live-abcdef\nGITHUB_TOKEN=ghp_secretvalue' } }, ['sk-live-abcdef', 'ghp_secretvalue']],
  ['header-style names in text', { tool: 'send', args: { text: 'curl -H "x-api-key: header-value-1"' } }, ['header-value-1']],
  ['prefixed header key', { tool: 'send', args: { headers: { 'x-api-key': 'key-value-1' } } }, ['key-value-1']],
  ['camel-case client secret key', { tool: 'send', args: { clientSecret: 'key-value-2' } }, ['key-value-2']],
  ['camel-case private key', { tool: 'send', args: { privateKey: 'key-value-3' } }, ['key-value-3']],
  ['camel-case names in text', { tool: 'write_file', args: { content: '{"clientSecret": "text-value-1"}' } }, ['text-value-1']],
  ['sk- value in prose', { tool: 'send', args: { text: `my apikey is ${fake('sk-proj-', 40)}` } }, [fake('sk-proj-', 40)]],
  ['GitHub token values', { tool: 'send', args: { text: `use ${fake('ghp_')} or ${fake('gho_')} or ${fake('github_pat_', 60)}` } }, [fake('ghp_'), fake('gho_'), fake('github_pat_', 60)]],
  ['Slack token values', { tool: 'send', args: { text: `bot ${fake('xoxb-', 40)} user ${fake('xoxp-', 40)}` } }, [fake('xoxb-', 40), fake('xoxp-', 40)]],
  ['AWS access key ID', { tool: 'send', args: { text: `aws id ${'AKIA' + 'ABCDEFGHIJ234567'} here` } }, ['AKIA' + 'ABCDEFGHIJ234567']],
  ['private key block', { tool: 'write_file', args: { content: 'id:\n-----BEGIN OPENSSH ' + 'PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n' } }, ['b3BlbnNzaC1rZXktdjEAAAAA']],
])('withholds credentials: %s', (_, action, originals) => {
  const { wire, incomplete } = scan({ action });
  expect(incomplete).toBe(true);
  for (const original of originals) expect(wire).not.toContain(original);
});

it('keeps token counts, ordinary key names and prose', () => {
  const action = { tool: 'write_file', read: { tokens: 1200, maxTokens: 4096, inputTokens: 12 }, args: { keyword: 'apple', senderKey: 'k', sceneKey: 's',
    content: 'Read 12000 tokens; max_tokens: 4096; maxTokens=4096; keyword: tokenizer.\nThe password reset link expired, so ask for a new token later.\nSee the desk-organizer-instructions-for-tomorrow note and the risk-assessment-template-version.' } };
  const { wire, incomplete } = scan({ action });
  expect(incomplete).toBe(false);
  expect(wire).not.toContain('[secret]');
  for (const kept of ['12000 tokens', 'max_tokens: [number', 'maxTokens=[number', 'keyword: tokenizer', 'password reset', 'desk-organizer-instructions-for-tomorrow', 'risk-assessment']) expect(wire).toContain(kept);
});

it('treats credential-named keys as credentials only when they carry text', () => {
  const flags = scan({ action: { tool: 'send', args: { includeCredentials: false, isSecret: true, requireAuthorization: true, token: '', cookie: [] } } });
  expect(flags.incomplete).toBe(false);
  expect(JSON.parse(flags.wire).action.args).toEqual({ includeCredentials: false, isSecret: true, requireAuthorization: true, token: '', cookie: [] });
  const nested = scan({ action: { tool: 'send', args: { credentials: { user: 'key-value-4' }, cookie: ['key-value-5'] } } });
  expect(nested.incomplete).toBe(true);
  for (const original of ['key-value-4', 'key-value-5']) expect(nested.wire).not.toContain(original);
});

it('aliases non-numeric scene keys in recent dialogue and matches them to the target address', () => {
  const input = { action: { tool: 'slack_send', args: { to: 'channel:secret-project', text: 'Update.' },
    context: { target: { to: 'channel:secret-project' }, recentDialogue: [{ world: 'slack', sceneKind: 'channel', sceneKey: 'slack:channel:secret-project', text: 'Posted in slack:channel:secret-project.' }] } } };
  const privacy = reviewPrivacy(); privacy.prepare(input);
  const clean = privacy.clean(input) as typeof input;
  expect(JSON.stringify(clean)).not.toContain('secret-project');
  expect(clean.action.context.recentDialogue[0].sceneKey).toMatch(/^\[identity\d+\]$/u);
  expect(clean.action.args.to).toBe(clean.action.context.recentDialogue[0].sceneKey);
  expect(clean.action.context.recentDialogue[0].text).toBe(`Posted in ${clean.action.args.to}.`);
  expect(privacy.incomplete).toBe(false);
});

it('aliases URLs before credential matching, so URL query parameters do not withhold the review', async () => {
  const link = 'https://www.xiaohongshu.com/explore/66f0a1?xsec_token=abc&xsec_source=pc_share';
  const shared = scan({ action: { tool: 'qq_draft', args: { to: 'group:123456', text: 'Nice.' },
    context: { scene: 'qq:group:123456', recentDialogue: [{ speaker: 'Alice', text: `看看这个 ${link}` }] } } });
  expect(shared.incomplete).toBe(false);
  expect(shared.wire).toMatch(/看看这个 \[url\d+\]/u);
  for (const original of ['xiaohongshu', 'xsec_token', '[secret]']) expect(shared.wire).not.toContain(original);
  const plain = scan({ action: { tool: 'send', args: { text: `TOKEN=plain-value-1 and ${link}` } } });
  expect(plain.incomplete).toBe(true);
  expect(plain.wire).not.toContain('plain-value-1');
  expect(plain.wire).toMatch(/TOKEN=\[secret\] and \[url\d+\]/u);

  const cfg = composeDefaults().appraisal!; cfg.provider = 'jev'; cfg.jev.allowRemoteText = true;
  const appraiser = new Appraiser(cfg, { getEnv: () => 'fixture-key', requestJev: async () => ({ answers: { rule0: { choice: 'allow' } } }) });
  try {
    expect(await appraiser.reviewAction({ tool: 'qq_draft', args: { to: 'group:123456', text: 'Nice.' }, context: { recentDialogue: [{ text: link }] } },
      [{ id: 'r', scope: { sessions: ['main', 'dream'], tags: ['speak' as const] }, instruction: 'Be concise.', exceptions: '' }])).toMatchObject({ kind: 'reviewed' });
  } finally { await appraiser.dispose(); }
});

it('masks whole cookie header values and whole quoted credentials, after aliasing URLs', () => {
  const { wire, incomplete } = scan({ action: { tool: 'send', args: {
    text: 'Cookie: harmless=one; session=SESSIONVALUEABCDE\npassword="two word secret"',
    note: 'Set-Cookie: id=COOKIEVALUE1; Path=/ see https://example.test/a?token=link-value\ntoken=\'say \\\'hi\\\' there\' kept',
  } } });
  expect(incomplete).toBe(true);
  const args = JSON.parse(wire).action.args;
  expect(args.text).toBe('Cookie: [secret]\npassword="[secret]"');
  expect(args.note).toBe('Set-Cookie: [secret]\ntoken=\'[secret]\' kept');
  for (const original of ['harmless', 'SESSIONVALUEABCDE', 'word secret', 'COOKIEVALUE1', 'link-value', 'there']) expect(wire).not.toContain(original);
  const url = scan({ action: { tool: 'send', args: { text: 'see https://example.test/a?token=link-value' } } });
  expect(url.incomplete).toBe(false);
  expect(JSON.parse(url.wire).action.args.text).toMatch(/^see \[url\d+\]$/u);
});

const legacyEmail = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu;

it('keeps the previous email matches', () => {
  const samples = ['alice@example.test', 'user@example.com-foo@bar.org', 'a@b.cc1x@y.zz', 'x_a.b@c.d.ef, 李@例子.中国', 'no email here', '@@a@b.cc'];
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  for (let i = 0; i < 3000; i++) samples.push(Array.from({ length: 1 + Math.floor(random() * 24) }, () => 'ab1._-@ .Z'[Math.floor(random() * 10)]).join(''));
  for (const sample of samples) expect(replaceEmails(sample, email => `<${email}>`)).toBe(sample.replace(legacyEmail, email => `<${email}>`));
});

it('processes long identifier strings in linear time', () => {
  const identifier = 'Ab1_x.y-'.repeat(37_500);
  const started = performance.now();
  const { wire } = scan({ action: { tool: 'send', args: { text: identifier, other: `${identifier}@example${identifier}` } } });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(wire).toContain(identifier.slice(0, 1000));
});

it('keeps CJK text intact around short identities and still aliases longer ones inside it', () => {
  const input = { action: { tool: 'qq_draft', args: { to: 'group:123456', text: '你好呀，好！小明同学说好。' },
    context: { recentDialogue: [{ speaker: '好', text: '你好呀' }, { speaker: '小明同学', text: '我是小明同学' }] } } };
  const privacy = reviewPrivacy(); privacy.prepare(input);
  const clean = privacy.clean(input) as typeof input;
  const [short, long] = clean.action.context.recentDialogue;
  expect(short.speaker).toMatch(/^\[identity\d+\]$/u);
  expect(short.text).toBe('你好呀');
  expect(clean.action.args.text).toBe(`你好呀，${short.speaker}！${long.speaker}说好。`);
  expect(long.text).toBe(`我是${long.speaker}`);
  expect(JSON.stringify(clean)).not.toContain('小明同学');
});

it('treats move_file targets without a slash as paths, not identities', () => {
  const input = { action: { tool: 'move_file', args: { from: 'notes/todo.md', to: 'todo.md' },
    change: { from: 'notes/todo.md', to: 'todo.md' } },
  history: [{ tool: 'move_file', args: { from: 'a.md', to: 'b.md' } }, { tool: 'read_file', args: { path: 'todo.md' } }] };
  const privacy = reviewPrivacy(); privacy.prepare(input);
  const clean = privacy.clean(input) as typeof input;
  expect(clean.action.args).toEqual({ from: 'notes/todo.md', to: 'todo.md' });
  expect(clean.action.change).toEqual({ from: 'notes/todo.md', to: 'todo.md' });
  expect(clean.history).toEqual(input.history);
  expect(JSON.stringify(clean)).not.toContain('[identity');
});
