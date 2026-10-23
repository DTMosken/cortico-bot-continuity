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
    [{ id: 'read-budget', scope: {}, instruction: 'For Alice, read fewer than 10000 characters.', exceptions: 'Contact alice@example.test if needed.' }]);
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

it('does not send secrets or a rule whose unclassified numeric meaning was removed', async () => {
  const cfg = composeDefaults().appraisal!; cfg.provider = 'jev'; cfg.jev.allowRemoteText = true;
  let calls = 0;
  const appraiser = new Appraiser(cfg, { getEnv: () => 'fixture-key', requestJev: async () => { calls++; throw new Error('unexpected request'); } });
  const rules = [{ id: 'private', scope: {}, instruction: 'Use necessary information only.', exceptions: '' }];
  try {
    expect(await appraiser.reviewAction({ tool: 'send', args: { authorization: 'Bearer a-private-credential' } }, rules)).toMatchObject({ kind: 'insufficient' });
    expect(await appraiser.reviewAction({ tool: 'send', args: { token: 'private-credential' } }, rules)).toMatchObject({ kind: 'insufficient' });
    expect(await appraiser.reviewAction({ tool: 'send', args: { text: 'password=private-credential' } }, rules)).toMatchObject({ kind: 'insufficient' });
    expect(await appraiser.reviewAction({ tool: 'write_file', args: { content: JSON.stringify({ password: 'private-credential' }) } }, rules)).toMatchObject({ kind: 'insufficient' });
    expect(await appraiser.reviewAction({ tool: 'send', args: { text: 'Authorization: Basic private-credential' } }, rules)).toMatchObject({ kind: 'insufficient' });
    expect(await appraiser.reviewAction({ tool: 'write_file', args: { content: JSON.stringify({ access_token: 'private-credential' }) } }, rules)).toMatchObject({ kind: 'insufficient' });
    expect(await appraiser.reviewAction({ tool: 'send', args: { text: 'refresh_token=private-credential' } }, rules)).toMatchObject({ kind: 'insufficient' });
    expect(await appraiser.reviewAction({ read: { chars: 12000 } }, [{ ...rules[0], instruction: 'Keep record 123456 unchanged.' }])).toMatchObject({ kind: 'insufficient' });
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
    const result = await appraiser.reviewAction({ tool: 'send' }, [{ id: 'r', scope: {}, instruction: 'Be concise.', exceptions: '' }]);
    expect(result).toMatchObject({ kind: 'unavailable' }); expect(JSON.stringify(result)).not.toContain('private-value');
  } finally { await appraiser.dispose(); }
});
