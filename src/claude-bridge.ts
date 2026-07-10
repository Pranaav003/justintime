import type { HydratedStep, OutlineStep, WalkthroughOutline } from './types';
import type { PlanProvider, RepoContext, SessionCtx, FileState } from './plan-source';
import { parseOutlinePayload, parseHydratedStep, outlineJsonSchema, hydratedStepJsonSchema } from './schema';
import {
  OUTLINE_SYSTEM_APPEND,
  HYDRATE_SYSTEM_APPEND,
  EXPLAIN_SYSTEM_APPEND,
  CHAT_SYSTEM_APPEND,
  buildOutlinePrompt,
  buildHydratePrompt,
  buildExplainPrompt,
  buildChatPrompt,
} from './prompt-templates';

/**
 * ClaudeAgentProvider — the MVP PlanProvider, wrapping the Claude Agent SDK's
 * `query()` (design Section 2). The SDK's `query` is injected as a `QueryFn` so
 * this module is fully testable without the SDK or a network; the real function
 * is adapted at extension wiring time.
 */

/** The subset of an SDK message we consume. */
export interface SdkResultMessage {
  type: 'result';
  subtype: string; // 'success' | 'error_max_structured_output_retries' | ...
  structured_output?: unknown;
  result?: string; // free-text final answer (when no outputFormat is set)
  session_id?: string;
}
export type SdkMessage = SdkResultMessage | { type: string; [key: string]: unknown };

export type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>;

export type ProviderErrorCode =
  | 'no_result'
  | 'max_retries'
  | 'sdk_error'
  | 'no_output'
  | 'no_session'
  | 'invalid_output';

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: ProviderErrorCode,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Turn a streamed SDK message into a short human progress string, if it is tool activity. */
function reportProgress(msg: SdkMessage, onProgress: (text: string) => void): void {
  const rec = msg as Record<string, unknown>;
  if (msg.type === 'tool_use_summary' && typeof rec.summary === 'string') {
    onProgress(rec.summary);
    return;
  }
  if (msg.type === 'assistant') {
    const message = rec.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
        if (b.type === 'tool_use') {
          onProgress(describeTool(b.name, b.input));
        }
      }
    }
  }
}

function describeTool(name?: string, input?: Record<string, unknown>): string {
  const i = input ?? {};
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Read':
      return `Reading ${str(i.file_path)}`;
    case 'Grep':
      return `Searching for “${str(i.pattern)}”`;
    case 'Glob':
      return `Scanning ${str(i.pattern) || str(i.path) || 'files'}`;
    default:
      return name ? `${name}…` : 'Working…';
  }
}

const READONLY_TOOLS = ['Read', 'Glob', 'Grep'];
// Known destructive tools removed from the model's context entirely. Anything
// else is still denied by permissionMode 'dontAsk' (deny-if-not-pre-approved).
const BLOCKED_TOOLS = ['Write', 'Edit', 'Bash'];

export interface ClaudeAgentProviderOptions {
  maxSteps?: number;
  /** Optional model override (blank = SDK/CLI default). For restricted keys/gateways. */
  model?: string;
  /** Path to the `claude` executable. Lets a lean package use the user's installed CLI. */
  claudeExecutable?: string;
  /** Cap the agentic exploration loop as a runaway backstop. */
  maxTurns?: number;
}

export class ClaudeAgentProvider implements PlanProvider {
  private readonly maxSteps: number;
  private readonly model?: string;
  private readonly claudeExecutable?: string;
  private readonly maxTurns?: number;

  constructor(
    private readonly query: QueryFn,
    options: ClaudeAgentProviderOptions = {},
  ) {
    this.maxSteps = options.maxSteps ?? 30;
    this.model = options.model;
    this.claudeExecutable = options.claudeExecutable;
    this.maxTurns = options.maxTurns;
  }

  /** SDK options conditional on provider config + a caller-supplied abort signal. */
  private sdkExtras(signal?: AbortSignal): Record<string, unknown> {
    const extras: Record<string, unknown> = {
      ...(this.model ? { model: this.model } : {}),
      ...(this.claudeExecutable ? { pathToClaudeCodeExecutable: this.claudeExecutable } : {}),
      ...(this.maxTurns ? { maxTurns: this.maxTurns } : {}),
    };
    if (signal) {
      // Bridge the caller's AbortSignal to the SDK's AbortController option.
      const ac = new AbortController();
      if (signal.aborted) {
        ac.abort();
      } else {
        signal.addEventListener('abort', () => ac.abort(), { once: true });
      }
      extras.abortController = ac;
    }
    return extras;
  }

  async produceOutline(problem: string, ctx: RepoContext): Promise<WalkthroughOutline> {
    const mode = ctx.mode ?? 'solve';
    const append = mode === 'explain' ? EXPLAIN_SYSTEM_APPEND : OUTLINE_SYSTEM_APPEND;
    const prompt =
      mode === 'explain' ? buildExplainPrompt(problem, this.maxSteps) : buildOutlinePrompt(problem, this.maxSteps);

    const result = await this.drain(prompt, {
      cwd: ctx.workspaceRoot,
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      allowedTools: READONLY_TOOLS,
      disallowedTools: BLOCKED_TOOLS,
      permissionMode: 'dontAsk',
      outputFormat: { type: 'json_schema', schema: outlineJsonSchema() },
      ...this.sdkExtras(ctx.signal),
    }, ctx.onProgress);

    const payload = this.parse(result, parseOutlinePayload);
    const sessionId = result.session_id;
    if (!sessionId) {
      throw new ProviderError('SDK result did not include a session_id', 'no_session');
    }
    return { ...payload, sessionId, mode };
  }

  async hydrateStep(step: OutlineStep, current: FileState, session: SessionCtx): Promise<HydratedStep> {
    const result = await this.drain(
      buildHydratePrompt(step, current),
      {
        // Stateless per-step query (no session resume — unreliable across SDK/
        // gateway versions). The prompt carries the step intent + current file.
        cwd: session.workspaceRoot,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: HYDRATE_SYSTEM_APPEND },
        allowedTools: READONLY_TOOLS,
        disallowedTools: BLOCKED_TOOLS,
        permissionMode: 'dontAsk',
        outputFormat: { type: 'json_schema', schema: hydratedStepJsonSchema() },
        ...this.sdkExtras(session.signal),
      },
      session.onProgress,
    );

    const payload = this.parse(result, parseHydratedStep);
    return { ...payload, hazards: [] };
  }

  async answerQuestion(question: string, contextText: string, ctx: RepoContext): Promise<string> {
    const result = await this.drain(buildChatPrompt(contextText, question), {
      cwd: ctx.workspaceRoot,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: CHAT_SYSTEM_APPEND },
      allowedTools: READONLY_TOOLS,
      disallowedTools: BLOCKED_TOOLS,
      permissionMode: 'dontAsk',
      ...this.sdkExtras(ctx.signal),
    }, ctx.onProgress);
    return typeof result.result === 'string' ? result.result : '';
  }

  /** Iterate the message stream and return the terminal result message (or throw). */
  private async drain(
    prompt: string,
    options: Record<string, unknown>,
    onProgress?: (text: string) => void,
  ): Promise<SdkResultMessage> {
    let result: SdkResultMessage | undefined;
    try {
      for await (const msg of this.query({ prompt, options })) {
        if (onProgress) {
          reportProgress(msg, onProgress);
        }
        if (msg.type === 'result') {
          result = msg as SdkResultMessage;
        }
      }
    } catch (err) {
      if (err instanceof ProviderError) {
        throw err;
      }
      throw new ProviderError(err instanceof Error ? err.message : String(err), 'sdk_error');
    }
    if (!result) {
      throw new ProviderError('SDK stream ended without a result message', 'no_result');
    }
    if (result.subtype !== 'success') {
      if (result.subtype === 'error_max_structured_output_retries') {
        throw new ProviderError('Model could not satisfy the output schema after retries', 'max_retries');
      }
      throw new ProviderError(`SDK returned error subtype '${result.subtype}'`, 'sdk_error');
    }
    return result;
  }

  /** Validate structured_output with the given parser, wrapping failures as invalid_output. */
  private parse<T>(result: SdkResultMessage, parser: (data: unknown) => T): T {
    if (result.structured_output === undefined) {
      throw new ProviderError('SDK result was success but had no structured_output', 'no_output');
    }
    try {
      return parser(result.structured_output);
    } catch (err) {
      throw new ProviderError(
        `Model output failed validation: ${err instanceof Error ? err.message : String(err)}`,
        'invalid_output',
      );
    }
  }
}
