import type { OutlineStep, WalkthroughOutline, HydratedStep, WalkthroughMode } from './types';

/**
 * The model-provider seam (design Section 2.1). The orchestrator depends only on
 * this interface, never on a concrete backend. MVP ships ClaudeAgentProvider;
 * an AnthropicMessagesProvider / OpenAIProvider can be added later without
 * touching the orchestrator or UI.
 */

export interface RepoContext {
  /** Absolute workspace root, used as the analysis cwd. */
  workspaceRoot: string;
  /** Which walkthrough to produce. Defaults to 'solve' when omitted. */
  mode?: WalkthroughMode;
  /** Aborts the in-flight query (cancel / timeout). */
  signal?: AbortSignal;
}

export interface SessionCtx {
  /** Provider session id captured during produceOutline, used to resume for hydration. */
  sessionId: string;
  /** Analysis cwd — must match the outline call so the SDK can resume the session. */
  workspaceRoot: string;
  /** Aborts the in-flight query (cancel / timeout). */
  signal?: AbortSignal;
}

/** Current contents of the step's target file(s), keyed by workspace-relative path. */
export type FileState = Record<string, string>;

export interface PlanProvider {
  produceOutline(problem: string, ctx: RepoContext): Promise<WalkthroughOutline>;
  hydrateStep(step: OutlineStep, current: FileState, session: SessionCtx): Promise<HydratedStep>;
  /** Optional read-only follow-up chat about the current step. */
  answerQuestion?(question: string, contextText: string, ctx: RepoContext): Promise<string>;
}
