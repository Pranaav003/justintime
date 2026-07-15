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

const SEARCH_CODE_TOOL = {
  type: 'function',
  function: {
    name: 'search_code',
    description:
      'Search the codebase for a keyword or JS regex and get matching file:line results. ' +
      'Use this to FIND relevant code before reading it (e.g. exception handling: search "except|raise|Error").',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A keyword or JavaScript regex.' } },
      required: ['query'],
    },
  },
};

const TOOLS = [SEARCH_CODE_TOOL, READ_FILES_TOOL];

const TOOL_PREAMBLE =
  'You are working through a VS Code extension and CANNOT browse the repository directly. ' +
  'To FIND relevant code, call search_code with a keyword or regex (e.g. for exception handling, ' +
  'search "except|raise|Error"); then call read_files to read the matching files. Request paths ' +
  'EXACTLY as they appear in the file list or search results — do not invent paths, and never ' +
  'describe code you have not actually read. Ground every statement in the file contents you fetched. ' +
  'When done exploring, output the requested JSON only.';

const MAX_TOOL_ROUNDS = 5;
const MAX_FILES_PER_CALL = 15;
const MAX_FILE_CHARS = 20_000;

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  const slice = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(slice);
}

const KNOWN_TOOL_NAMES = TOOLS.map((t) => t.function.name);

/**
 * Weak local models often emit a tool call as JSON *text* in `content`
 * (e.g. `{"name":"search_code","arguments":{"query":"x"}}`) instead of the
 * structured `tool_calls` array. Recognize that shape so we execute the tool
 * and ground the answer, rather than handing the raw JSON back to the user.
 */
export function detectTextToolCall(content: string): ToolCall | undefined {
  if (!content || !content.includes('{')) {
    return undefined;
  }
  let obj: unknown;
  try {
    obj = extractJson(content);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }
  const rec = obj as Record<string, unknown>;
  const name = typeof rec.name === 'string' ? rec.name : undefined;
  if (!name || !KNOWN_TOOL_NAMES.includes(name)) {
    return undefined;
  }
  const rawArgs = rec.arguments ?? rec.parameters ?? {};
  const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
  return { id: `text-${name}`, type: 'function', function: { name, arguments: args } };
}

/** Map a possibly-approximate requested path to a real one from the repo map. */
export function resolvePath(requested: string, repoMap?: string[]): string | undefined {
  if (!repoMap || repoMap.length === 0) {
    return requested; // no map to check against; try as-is
  }
  if (repoMap.includes(requested)) {
    return requested;
  }
  const base = requested.split('/').pop() ?? requested;
  // Prefer a unique suffix match, else a unique basename match.
  const suffix = repoMap.filter((f) => f.endsWith(`/${requested}`) || f === requested);
  if (suffix.length === 1) {
    return suffix[0];
  }
  const byBase = repoMap.filter((f) => (f.split('/').pop() ?? f) === base);
  if (byBase.length === 1) {
    return byBase[0];
  }
  return undefined; // ambiguous or unknown — report as not found with the file list
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
    const payload = await this.completeJson(messages, session.signal, (d) =>
      parseHydratedStep(d, { primaryFile: step.targetFiles[0], stepNumber: step.stepNumber }),
    );
    return { ...payload, hazards: [] };
  }

  async answerQuestion(question: string, contextText: string, ctx: RepoContext): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: `${TOOL_PREAMBLE}\n\n${CHAT_SYSTEM_APPEND}` },
      { role: 'user', content: buildChatPrompt(contextText, question) },
    ];
    // The final non-tool message from the explore loop IS the answer — no extra
    // call (which would drop tools and make the model emit "let me search…" prose).
    const answer = await this.explore(messages, ctx);
    // Weak models sometimes end on a text-embedded tool call (or empty content)
    // instead of prose. If so, force one tools-off completion so the user gets a
    // grounded natural-language answer rather than raw JSON. `messages` now holds
    // the full tool transcript (explore mutates it), so this call has context.
    if (!answer.trim() || detectTextToolCall(answer)) {
      const finalMsg = await this.chat(
        [
          ...messages,
          {
            role: 'user',
            content:
              'Now answer the question in plain prose based on what you found above. Do not call any tools or output JSON.',
          },
        ],
        { signal: ctx.signal },
      );
      return finalMsg.content.trim() || answer;
    }
    return answer;
  }

  /** Run search_code / read_files tool rounds; returns the final non-tool assistant text. */
  private async explore(messages: ChatMessage[], ctx: RepoContext): Promise<string> {
    let lastContent = '';
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Force at least one tool call up front so weak models ground in real code
      // before answering, instead of hallucinating.
      const msg = await this.chat(messages, {
        tools: TOOLS,
        toolChoice: round === 0 ? 'required' : 'auto',
        signal: ctx.signal,
      });
      lastContent = msg.content;
      let toolCalls = msg.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // Fall back to a text-embedded tool call (weak-model shape) before giving up.
        const textCall = detectTextToolCall(msg.content);
        if (!textCall) {
          return lastContent;
        }
        toolCalls = [textCall];
      }
      const fromTextCall = toolCalls !== msg.tool_calls;
      // For a synthesized call, blank the content so the model doesn't re-see its own JSON.
      messages.push({ role: 'assistant', content: fromTextCall ? '' : msg.content, tool_calls: toolCalls });
      for (const call of toolCalls) {
        let result: string;
        if (call.function.name === 'read_files') {
          result = await this.serveReadFiles(call.function.arguments, ctx);
        } else if (call.function.name === 'search_code') {
          result = await this.serveSearch(call.function.arguments, ctx);
        } else {
          result = `Unknown tool ${call.function.name}`;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
    return lastContent; // hit the round cap; return whatever we last got
  }

  private async serveSearch(argsJson: string, ctx: RepoContext): Promise<string> {
    let query = '';
    try {
      const parsed = JSON.parse(argsJson || '{}') as { query?: unknown };
      query = typeof parsed.query === 'string' ? parsed.query : '';
    } catch {
      return '(could not parse search_code arguments)';
    }
    if (!query) {
      return '(empty query)';
    }
    ctx.onProgress?.(`Searching for “${query}”`);
    return ctx.searchCode ? await ctx.searchCode(query) : '(search unavailable)';
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
    for (const requested of paths) {
      const resolved = resolvePath(requested, ctx.repoMap);
      ctx.onProgress?.(`Reading ${resolved ?? requested}`);
      const content = ctx.readFile && resolved ? await ctx.readFile(resolved) : undefined;
      if (content === undefined) {
        const hint = ctx.repoMap && ctx.repoMap.length > 0 ? ` Available files: ${ctx.repoMap.slice(0, 60).join(', ')}` : '';
        parts.push(`--- ${requested} --- (not found).${hint}`);
      } else {
        const label = resolved && resolved !== requested ? `${resolved} (resolved from ${requested})` : requested;
        parts.push(`--- ${label} ---\n${content.slice(0, MAX_FILE_CHARS)}`);
      }
    }
    return parts.join('\n\n') || '(no files requested)';
  }


  /** One chat call; returns the assistant message content + any tool calls. */
  private async chat(
    messages: ChatMessage[],
    opts: { tools?: unknown[]; toolChoice?: 'auto' | 'required'; json?: boolean; signal?: AbortSignal },
  ): Promise<{ content: string; tool_calls?: ToolCall[] }> {
    const body: Record<string, unknown> = { model: this.model, messages, temperature: 0 };
    if (opts.tools) {
      body.tools = opts.tools;
      body.tool_choice = opts.toolChoice ?? 'auto';
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
    // Keep the raw validation detail in the extension log, but show the user a concise hint.
    console.error(`[JustInTime] ${this.label} structured-output failure:`, lastErr);
    throw new Error(
      `${this.label} (${this.model}) didn't return a valid plan. Smaller local models often struggle with structured output — try Explain mode, or a more capable model.`,
    );
  }
}
