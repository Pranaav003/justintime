import type { PlanProvider, RepoContext, FileState, SessionCtx } from './plan-source';
import type { OutlineStep, WalkthroughOutline, HydratedStep } from './types';
import { runCodexCompletion, type CodexCompletionRunner } from './codex-cli';
import { OpenAICompatibleProvider, extractJson, detectTextToolCall, type FetchFn } from './openai-provider';
import { parseOutlinePayload, parseHydratedStep } from './schema';
import { applyHunks } from './anchor';

export interface CodexCliProviderConfig {
  model?: string;
  executable?: string;
  maxSteps?: number;
  timeoutMs?: number;
  workspaceRoots?: string[];
  log?: (level: 'error' | 'warn' | 'info', message: string, error?: unknown) => void;
}

interface Envelope {
  content: string;
  tool_calls: { name: 'read_files' | 'search_code'; paths: string[]; query: string }[];
}

/** Codex strict output requires every object property to be required, even tool placeholders. */
function envelopeSchema(tools: boolean, required: boolean): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false, required: ['content', 'tool_calls'],
    properties: {
      content: { type: 'string' },
      tool_calls: {
        type: 'array', ...(!tools ? { maxItems: 0 } : required ? { minItems: 1 } : {}),
        items: {
          type: 'object', additionalProperties: false, required: ['name', 'paths', 'query'],
          properties: {
            name: { type: 'string', enum: ['read_files', 'search_code'] },
            paths: { type: 'array', items: { type: 'string' } },
            query: { type: 'string' },
          },
        },
      },
    },
  };
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseEnvelope(raw: string, tools: boolean, required: boolean): Envelope {
  const value: unknown = JSON.parse(raw);
  if (!exactObject(value, ['content', 'tool_calls']) || typeof value.content !== 'string'
    || !Array.isArray(value.tool_calls) || (!tools && value.tool_calls.length > 0)
    || (required && value.tool_calls.length === 0)) {
    throw new Error('Invalid completion envelope');
  }
  for (const call of value.tool_calls) {
    if (!exactObject(call, ['name', 'paths', 'query'])
      || (call.name !== 'read_files' && call.name !== 'search_code')
      || !Array.isArray(call.paths) || !call.paths.every((path) => typeof path === 'string')
      || typeof call.query !== 'string') {
      throw new Error('Invalid tool arguments');
    }
  }
  return value as unknown as Envelope;
}

/**
 * Reuses the existing callback-based source exploration and evidence gate. The
 * fetch seam is an in-process translation into CLI completions; it makes no HTTP
 * requests. Each public operation owns its validator and one formatting retry.
 */
export class CodexCliProvider implements PlanProvider {
  private readonly model: string;

  constructor(
    private readonly config: CodexCliProviderConfig = {},
    private readonly runner: CodexCompletionRunner = runCodexCompletion,
  ) {
    this.model = config.model?.trim() ? config.model : 'gpt-6-sol';
  }

  async produceOutline(problem: string, ctx: RepoContext): Promise<WalkthroughOutline> {
    this.requireCallbacks(ctx);
    const provider = this.delegate(ctx.workspaceRoot, (content) => { parseOutlinePayload(extractJson(content)); });
    const outline = await provider.produceOutline(problem, ctx);
    return { ...outline, sessionId: `codex-${this.model}` };
  }

  async hydrateStep(step: OutlineStep, current: FileState, session: SessionCtx): Promise<HydratedStep> {
    const provider = this.delegate(session.workspaceRoot, (content) => {
      const payload = parseHydratedStep(extractJson(content), { primaryFile: step.targetFiles[0], stepNumber: step.stepNumber });
      if (payload.changeKind === 'edit') {
        const source = Object.hasOwn(current, payload.primaryFile) ? current[payload.primaryFile] : undefined;
        if (source === undefined || applyHunks(source, payload.hunks ?? []).status !== 'ok') {
          throw new Error('Edit hunks do not anchor against the supplied current file.');
        }
      }
    }, 'For edit hunks, copy contextBefore, oldText, and contextAfter as one contiguous verbatim block from the supplied current file, with no skipped lines.');
    return provider.hydrateStep(step, current, session);
  }

  async answerQuestion(question: string, contextText: string, ctx: RepoContext): Promise<string> {
    this.requireCallbacks(ctx);
    const provider = this.delegate(ctx.workspaceRoot, (content) => {
      if (!content.trim() || detectTextToolCall(content)) throw new Error('Expected a prose answer');
    });
    return provider.answerQuestion(question, contextText, ctx);
  }

  private requireCallbacks(ctx: RepoContext): void {
    if (!ctx.readFile && !ctx.searchCode) {
      throw new Error('Codex requires workspace read/search callbacks to obtain code evidence.');
    }
  }

  private delegate(workspaceRoot: string, validateTerminal: (content: string) => void, correction = ''): OpenAICompatibleProvider {
    let formattingFailures = 0;
    let callNumber = 0;
    const fetchFn: FetchFn = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string }[];
        tools?: unknown[];
        tool_choice?: string;
      };
      const tools = Boolean(body.tools);
      const required = tools && body.tool_choice === 'required';
      const messages = [...body.messages];
      const signal = init?.signal ?? undefined;
      for (;;) {
        signal?.throwIfAborted();
        const prompt = [
          'This completion uses a JSON request protocol, not native tool invocations. Do not explore files through native CLI commands. When host tools are enabled below, emit read_files/search_code requests as typed entries in tool_calls; the host executes them after this completion and provides results in the next call. These are not registered native functions: their absence from native tools is expected and does not prevent JSON tool requests.',
          'Return exactly one JSON object with content:string and tool_calls:array. Every tool has name, paths:string[], query:string.',
          tools
            ? 'To request source, use read_files with paths and an empty query, or search_code with query and empty paths. For a final answer put text (or the requested domain JSON serialized as a string) in content and use tool_calls: [].'
            : 'Tools are unavailable. Use tool_calls: [] and place the requested domain JSON serialized as a string in content. The supplied current file contents are authoritative.',
          body.tool_choice === 'required' ? 'Workspace evidence is required before a final answer. Request the available host read/search tools first.' : '',
          'Conversation messages:\n' + JSON.stringify(messages),
        ].filter(Boolean).join('\n');
        // Transport errors and cancellation are outside formatting recovery.
        const raw = await this.runner({
          prompt, model: this.model, schema: envelopeSchema(tools, required), workspaceRoot,
          workspaceRoots: this.config.workspaceRoots, executable: this.config.executable,
          timeoutMs: this.config.timeoutMs, signal, log: this.config.log,
        });
        signal?.throwIfAborted();
        let envelope: Envelope;
        try {
          envelope = parseEnvelope(raw, tools, required);
          if (envelope.tool_calls.length === 0) validateTerminal(envelope.content);
        } catch {
          if (formattingFailures++ >= 1) throw new Error(`Codex (${this.model}) did not return a valid response matching the required schema.`);
          messages.push({ role: 'user', content: ['The previous response did not match the required schema. Return a valid strict envelope and valid requested content, with every required property and no additional properties.', correction].filter(Boolean).join(' ') });
          continue;
        }
        const tool_calls = envelope.tool_calls.map((call, index) => ({
          id: `codex-${++callNumber}-${index}`, type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.name === 'read_files' ? { paths: call.paths } : { query: call.query }),
          },
        }));
        return new Response(JSON.stringify({ choices: [{ message: { content: envelope.content, tool_calls } }] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
    };
    return new OpenAICompatibleProvider({
      baseUrl: 'http://codex.invalid/v1', apiKey: '', model: this.model, label: 'Codex',
      maxSteps: this.config.maxSteps, log: this.config.log, fetchFn,
    });
  }
}
