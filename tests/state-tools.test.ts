import { expect, it } from 'vitest';
import { nullLogger } from 'cortico/core/util.ts';
import type { ToolSpec } from 'cortico/core/types.ts';
import { stateReviewTools } from '../persona/state-tools.ts';

it('reads changing session contracts on demand and includes schemas only for selected names', async () => {
  const lookup: ToolSpec = { name: 'archive_lookup', tags: ['read'], description: 'Search archived notes.\nUse limit to bound the result.', parameters: { type: 'object', properties: { limit: { type: 'integer' } } } };
  const publish: ToolSpec = { name: 'forum_publish', tags: ['act'], description: 'Publish a post.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } };
  const sessions = [{ session: 'main', tools: [lookup, publish] }, { session: 'dream', tools: [lookup] }];
  const tool = stateReviewTools(() => sessions);
  const read = async (args: Record<string, unknown> = {}) => JSON.parse(String(await tool.handler(args, { role: 'dream', log: nullLogger() })));
  expect(await read()).toEqual({ tools: [
    { name: lookup.name, tags: lookup.tags, sessions: ['main', 'dream'], description: 'Search archived notes.' },
    { name: publish.name, tags: publish.tags, sessions: ['main'], description: publish.description },
  ] });
  expect(await read({ names: [publish.name, 'missing_tool'] })).toEqual({ tools: [{ ...publish, sessions: ['main'] }], unavailable: ['missing_tool'] });
  sessions[0].tools = [lookup];
  expect(await read({ names: [publish.name] })).toEqual({ tools: [], unavailable: [publish.name] });
  expect(await tool.handler({}, { role: 'main', log: nullLogger() })).toContain('Dream only');
  expect(await tool.handler({ names: 'all' }, { role: 'dream', log: nullLogger() })).toContain('array');
});
