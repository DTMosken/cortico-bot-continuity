/** Persona-owned worker loop; Core still owns provider binding, media and session telemetry. */
import type { Core } from 'cortico/core/core.ts';
import type { Logger, ModelSpec, ToolDef } from 'cortico/core/types.ts';
import { GenerationError, type ProviderAttempt, type ResponseClient } from 'cortico/core/generation.ts';
import { withBlobLines } from 'cortico/core/blobs.ts';
import { estimateMessagesTokens, estimateTokens } from 'cortico/core/util.ts';
import { functionResult, message, responseRecords, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { responseRequest, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { ResponseAccumulator } from 'cortico/protocol/open-responses/stream.ts';
import { NOT_EXECUTED_BARRIER, NOT_EXECUTED_INCOMPLETE, NOT_EXECUTED_THREAD_ENDED, forkUnknownTool, toolFailed } from 'cortico/core/markers.ts';

/** Adapted from CortiV balancedSnapshot (Pal-AI-Lab/Cortico, Phantivia). Keep whole responses and paired calls. */
export function balancedSnapshot(snapshot: readonly ContextRecord[]): ContextRecord[] {
  const pending = new Set<string>();
  let end = 0;
  snapshot.forEach((record, index) => {
    if (record.item.type === 'function_call') pending.add(record.item.call_id);
    if (record.item.type === 'function_call_output') pending.delete(record.item.call_id);
    const key = record.context.responseId;
    if (!pending.size && !(key !== undefined && snapshot[index + 1]?.context.responseId === key)) end = index + 1;
  });
  return structuredClone(snapshot.slice(0, end));
}

export interface WorkerProgress { rounds: number; peakInputTokens: number | null; estimatedInputTokens: number; text: string; }
export interface WorkerResult { text: string; reason: 'natural' | 'finish' | 'ends_turn' | 'round_limit' | 'context_limit' | 'stopped'; }
export interface WorkerOptions {
  core: Core; llm: ResponseClient; spec: ModelSpec; messages: ContextRecord[]; tools: ToolDef[];
  log: Logger;
  maxRounds: number; softRounds: number; contextTokens: number; signal: AbortSignal; label: string;
  stopped(): boolean; finished(): boolean; progress(value: WorkerProgress): void;
}

function contextOverflow(error: unknown): boolean {
  const text = error instanceof GenerationError ? error.message + '\n' + error.body : String(error);
  return /context_length_exceeded|context_window_exceeded|maximum context length|input (?:tokens|length).*(?:exceed|too long)|prompt is too long/i.test(text);
}

export async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  const { core, llm, spec, tools, signal } = options;
  const messages = [...options.messages], observed = [...messages];
  const track = core.sessions.open('subagent', options.label, { messagesRef: () => observed });
  const schemas = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const schemaTokens = estimateTokens(JSON.stringify(schemas));
  const progress: WorkerProgress = { rounds: 0, peakInputTokens: null, estimatedInputTokens: 0, text: '' };
  let warned = false;
  const stopped = () => signal.aborted || options.stopped();
  const attempts = (values: ProviderAttempt[]) => {
    track.recordAttempts(values, observed);
    for (const attempt of values) if (attempt.meters.input !== null) {
      progress.peakInputTokens = Math.max(progress.peakInputTokens ?? 0, attempt.meters.input);
    }
    options.progress(progress);
  };
  const result = (reason: WorkerResult['reason']): WorkerResult => ({ text: progress.text, reason });
  try {
    for (let round = 1; round <= options.maxRounds; round++) {
      if (stopped()) return result('stopped');
      let estimate = estimateMessagesTokens(messages) + schemaTokens;
      if (!warned && estimate >= options.contextTokens * 0.8 && estimate < options.contextTokens) {
        warned = true;
        const warning = message('user', `[system] Context estimate ${estimate}/${options.contextTokens} input tokens (80% warning). Tools remain available. Preserve useful findings before the input limit is reached.`);
        messages.push(warning); observed.push(warning);
        estimate = estimateMessagesTokens(messages) + schemaTokens;
      }
      progress.estimatedInputTokens = estimate;
      options.progress(progress);
      if (estimate >= options.contextTokens) return result('context_limit');
      progress.rounds = round; options.progress(progress);
      let draft = new ResponseAccumulator();
      const settledLength = observed.length;
      let generated;
      try {
        generated = await llm.respond(responseRequest(spec, messages, schemas), {
          role: 'subagent', sessionId: track.id, context: messages, nativeSpec: spec, signal,
          onEvent: event => {
            if (event.type === 'response.created') draft = new ResponseAccumulator();
            draft.accept(event);
            const snapshot = draft.snapshot();
            if (snapshot) observed.splice(settledLength, observed.length - settledLength,
              ...snapshot.output.map(item => ({ version: 2 as const, item, context: { responseId: snapshot.id } })));
          },
        });
      } catch (error) {
        if (error instanceof GenerationError) attempts(error.attempts);
        if (stopped()) return result('stopped');
        if (contextOverflow(error)) return result('context_limit');
        throw error;
      }
      const output = responseRecords(generated.response, generated.origin);
      messages.push(...output); observed.splice(settledLength, observed.length - settledLength, ...output);
      attempts(generated.attempts);
      const text = output.filter(entry => entry.item.type === 'message').map(textOf).join('');
      if (text && !stopped()) { progress.text = text; options.progress(progress); }
      const calls = generated.response.output.filter(item => item.type === 'function_call');
      let barrier = false, ended = false;
      for (const [index, call] of calls.entries()) {
        const def = tools.find(tool => tool.name === call.name);
        let out: string;
        let blobs;
        if (stopped() || ended || options.finished()) out = NOT_EXECUTED_THREAD_ENDED;
        else if (barrier) out = NOT_EXECUTED_BARRIER;
        else if (call.status !== 'completed') { out = NOT_EXECUTED_INCOMPLETE; barrier = true; }
        else if (!def) out = forkUnknownTool(call.name);
        else {
          try {
            const args: unknown = JSON.parse(call.arguments || '{}');
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
            const receipt = await def.handler(args as Record<string, unknown>, { role: 'subagent', log: options.log, callId: call.call_id, signal, round });
            if (typeof receipt === 'string') out = receipt;
            else {
              blobs = core.internBlobs(receipt.blobs);
              out = withBlobLines((receipt.failed ? '[failed] ' : '') + receipt.text, blobs);
            }
            ended = def.endsTurn === true;
          } catch (error) { out = toolFailed(error instanceof Error ? error.message : String(error)); }
          barrier = def.barrierAfter === true;
        }
        if (round >= options.softRounds && index === calls.length - 1) out += `\n[system] Used ${round}/${options.maxRounds} model rounds; ${options.maxRounds - round} remain. Tools remain available.`;
        const receipt = functionResult(call.call_id, out, blobs ? { blobs } : {});
        messages.push(receipt); observed.push(receipt);
      }
      if (stopped()) return result('stopped');
      if (options.finished()) return result('finish');
      if (ended) return result('ends_turn');
      if (!calls.length) return result('natural');
    }
    return result('round_limit');
  } finally { track.close(); }
}
