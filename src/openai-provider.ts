import type { PlanProvider, RepoContext, SessionCtx, FileState } from './plan-source';
import type { WalkthroughOutline, OutlineStep, HydratedStep } from './types';
import { parseOutlinePayload, parseHydratedStep } from './schema';
import {
  OUTLINE_SYSTEM_APPEND,
  HYDRATE_SYSTEM_APPEND,
  EXPLAIN_SYSTEM_APPEND,
  CHAT_SYSTEM_APPEND,
  buildOutlinePrompt,
  buildExplainPrompt,
  buildHydratePrompt,
  buildChatPrompt,
} from './prompt-templates';

/**
 * A PlanProvider for any OpenAI-compatible /chat/completions endpoint
 * (OpenAI, Ollama's /v1, vLLM, LM Studio, custom gateways). Unlike the Claude
 * Agent SDK, these have no built-in codebase tools, so exploration is done via
 * a `read_files` tool loop: the model requests files, we serve their contents.
 *
 * Structured output uses response_format json_object + zod validation with one
 * retry (the most portable option across backends). `fetch` is injectable for
 * hermetic tests.
 */

export type FetchFn = typeof fetch;

export interface OpenAIProviderConfig {
  /** Base URL including the version segment, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Human label for error messages (e.g. "OpenAI", "Ollama"). */
  label?: string;
  maxSteps?: number;
  fetchFn?: FetchFn;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

const READ_FILES_TOOL = {
  type: 'function',
  function: {
    name: 'read_files',
    description: 'Read the full contents of specific workspace-relative files to inform your answer.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative file paths.' },
      },
      required: ['paths'],
    },
  },
};

const TOOL_PREAMBLE =
  'You are working through a VS Code extension and CANNOT browse the repository directly. ' +
  'A file list is provided. Use the read_files tool to fetch the contents of files you need ' +
  '(instead of Read/Glob/Grep) before producing your answer. When done exploring, output the requested JSON only.';

const MAX_TOOL_ROUNDS = 5;
const MAX_FILES_PER_CALL = 15;
const MAX_FILE_CHARS = 20_000;

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  const slice = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(slice);
}

export class OpenAICompatibleProvider implements PlanProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly label: string;
  private readonly maxSteps: number;
  private readonly fetchFn: FetchFn;

  constructor(config: OpenAIProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.label = config.label ?? 'OpenAI-compatible';
    this.maxSteps = config.maxSteps ?? 30;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  async produceOutline(problem: string, ctx: RepoContext): Promise<WalkthroughOutline> {
    const mode = ctx.mode ?? 'solve';
    const append = mode === 'explain' ? EXPLAIN_SYSTEM_APPEND : OUTLINE_SYSTEM_APPEND;
    const userPrompt =
      mode === 'explain'
        ? buildExplainPrompt(problem, this.maxSteps, ctx.repoMap)
        : buildOutlinePrompt(problem, this.maxSteps, ctx.repoMap);

    const messages: ChatMessage[] = [
      { role: 'system', content: `${TOOL_PREAMBLE}\n\n${append}` },
      { role: 'user', content: userPrompt },
    ];
    await this.explore(messages, ctx);
    const payload = await this.completeJson(messages, ctx.signal, parseOutlinePayload);
    // OpenAI-compatible endpoints don't expose a resumable session id.
    return { ...payload, sessionId: `openai-${this.model}`, mode };
  }

  async hydrateStep(step: OutlineStep, current: FileState, session: SessionCtx): Promise<HydratedStep> {
    const messages: ChatMessage[] = [
      { role: 'system', content: HYDRATE_SYSTEM_APPEND },
      { role: 'user', content: buildHydratePrompt(step, current) },
    ];
    const payload = await this.completeJson(messages, session.signal, parseHydratedStep);
    return { ...payload, hazards: [] };
  }

  async answerQuestion(question: string, contextText: string, ctx: RepoContext): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: `${TOOL_PREAMBLE}\n\n${CHAT_SYSTEM_APPEND}` },
      { role: 'user', content: buildChatPrompt(contextText, question) },
    ];
    await this.explore(messages, ctx);
    const msg = await this.chat(messages, { signal: ctx.signal });
    return msg.content;
  }

  /** Run read_files tool rounds until the model stops requesting files. */
  private async explore(messages: ChatMessage[], ctx: RepoContext): Promise<void> {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const msg = await this.chat(messages, { tools: [READ_FILES_TOOL], signal: ctx.signal });
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return;
      }
      messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        const result =
          call.function.name === 'read_files'
            ? await this.serveReadFiles(call.function.arguments, ctx)
            : `Unknown tool ${call.function.name}`;
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
  }

  private async serveReadFiles(argsJson: string, ctx: RepoContext): Promise<string> {
    let paths: string[] = [];
    try {
      const parsed = JSON.parse(argsJson || '{}') as { paths?: unknown };
      if (Array.isArray(parsed.paths)) {
        paths = parsed.paths.filter((p): p is string => typeof p === 'string').slice(0, MAX_FILES_PER_CALL);
      }
    } catch {
      return '(could not parse read_files arguments)';
    }
    const parts: string[] = [];
    for (const p of paths) {
      ctx.onProgress?.(`Reading ${p}`);
      const content = ctx.readFile ? await ctx.readFile(p) : undefined;
      parts.push(`--- ${p} ---\n${content === undefined ? '(not found)' : content.slice(0, MAX_FILE_CHARS)}`);
    }
    return parts.join('\n\n') || '(no files requested)';
  }

  /** One chat call; returns the assistant message content + any tool calls. */
  private async chat(
    messages: ChatMessage[],
    opts: { tools?: unknown[]; json?: boolean; signal?: AbortSignal },
  ): Promise<{ content: string; tool_calls?: ToolCall[] }> {
    const body: Record<string, unknown> = { model: this.model, messages, temperature: 0 };
    if (opts.tools) {
      body.tools = opts.tools;
      body.tool_choice = 'auto';
    }
    if (opts.json) {
      body.response_format = { type: 'json_object' };
    }
    const resp = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`${this.label} API ${resp.status}: ${detail.slice(0, 300)}`);
    }
    const data = (await resp.json()) as { choices?: { message?: { content?: unknown; tool_calls?: ToolCall[] } }[] };
    const m = data.choices?.[0]?.message ?? {};
    return { content: typeof m.content === 'string' ? m.content : '', tool_calls: m.tool_calls };
  }

  /** Force a JSON object, validate with the given parser, retry once on failure. */
  private async completeJson<T>(
    messages: ChatMessage[],
    signal: AbortSignal | undefined,
    parser: (data: unknown) => T,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const msg = await this.chat(messages, { json: true, signal });
      try {
        return parser(extractJson(msg.content));
      } catch (e) {
        lastErr = e;
        if (attempt === 0) {
          messages.push({ role: 'assistant', content: msg.content });
          messages.push({
            role: 'user',
            content: `That response did not match the required schema (${e instanceof Error ? e.message : String(e)}). Return ONLY a valid JSON object that matches it — no prose, no code fences.`,
          });
        }
      }
    }
    throw new Error(`${this.label}: model did not return schema-valid JSON (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);
  }
}
