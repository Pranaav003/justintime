import type { HydratedStep, OutlineStep, WalkthroughOutline } from './types';
import type { PlanProvider, RepoContext, SessionCtx, FileState } from './plan-source';
import { parseOutlinePayload, parseHydratedStep, outlineJsonSchema, hydratedStepJsonSchema } from './schema';
import {
  OUTLINE_SYSTEM_APPEND,
  HYDRATE_SYSTEM_APPEND,
  buildOutlinePrompt,
  buildHydratePrompt,
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

const READONLY_TOOLS = ['Read', 'Glob', 'Grep'];
const BLOCKED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'];

export interface ClaudeAgentProviderOptions {
  maxSteps?: number;
}

export class ClaudeAgentProvider implements PlanProvider {
  private readonly maxSteps: number;

  constructor(
    private readonly query: QueryFn,
    options: ClaudeAgentProviderOptions = {},
  ) {
    this.maxSteps = options.maxSteps ?? 30;
  }

  async produceOutline(problem: string, ctx: RepoContext): Promise<WalkthroughOutline> {
    const result = await this.drain(buildOutlinePrompt(problem, this.maxSteps), {
      cwd: ctx.workspaceRoot,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: OUTLINE_SYSTEM_APPEND },
      allowedTools: READONLY_TOOLS,
      disallowedTools: BLOCKED_TOOLS,
      permissionMode: 'dontAsk',
      outputFormat: { type: 'json_schema', schema: outlineJsonSchema() },
    });

    const payload = this.parse(result, parseOutlinePayload);
    const sessionId = result.session_id;
    if (!sessionId) {
      throw new ProviderError('SDK result did not include a session_id', 'no_session');
    }
    return { ...payload, sessionId };
  }

  async hydrateStep(step: OutlineStep, current: FileState, session: SessionCtx): Promise<HydratedStep> {
    const result = await this.drain(
      buildHydratePrompt(step.stepNumber, step.title, step.changeKind, current),
      {
        resume: session.sessionId,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: HYDRATE_SYSTEM_APPEND },
        allowedTools: READONLY_TOOLS,
        disallowedTools: BLOCKED_TOOLS,
        permissionMode: 'dontAsk',
        outputFormat: { type: 'json_schema', schema: hydratedStepJsonSchema() },
      },
    );

    const payload = this.parse(result, parseHydratedStep);
    return { ...payload, hazards: [] };
  }

  /** Iterate the message stream and return the terminal result message (or throw). */
  private async drain(prompt: string, options: Record<string, unknown>): Promise<SdkResultMessage> {
    let result: SdkResultMessage | undefined;
    try {
      for await (const msg of this.query({ prompt, options })) {
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
