import type { OutlineStep, WalkthroughOutline, HydratedStep, WalkthroughMode } from './types';

/**
 * The model-provider seam (design Section 2.1). The orchestrator depends only on
 * this interface, never on a concrete backend. ClaudeAgentProvider and
 * OpenAICompatibleProvider implement it for the supported backends.
 */

export interface RepoContext {
  /** Absolute workspace root, used as the analysis cwd. */
  workspaceRoot: string;
  /** Which walkthrough to produce. Defaults to 'solve' when omitted. */
  mode?: WalkthroughMode;
  /** Aborts the in-flight query (cancel / timeout). */
  signal?: AbortSignal;
  /** Called with a short human string as the model reads/searches files. */
  onProgress?: (text: string) => void;
  /** Pre-enumerated workspace file list so the model skips tree-discovery turns. */
  repoMap?: string[];
  /** Reads a workspace-relative file — used by providers that lack built-in file tools. */
  readFile?: (relPath: string) => Promise<string | undefined>;
  /** Greps the workspace for a keyword/regex — used by providers that lack a search tool. */
  searchCode?: (query: string) => Promise<string>;
}

export interface SessionCtx {
  /** Provider session identifier captured during produceOutline; hydration is stateless. */
  sessionId: string;
  /** Absolute workspace root used as the analysis cwd. */
  workspaceRoot: string;
  /** Aborts the in-flight query (cancel / timeout). */
  signal?: AbortSignal;
  /** Called with a short human string as the model reads/searches files. */
  onProgress?: (text: string) => void;
}

/** Current contents of the step's target file(s), keyed by workspace-relative path. */
export type FileState = Record<string, string>;

export interface PlanProvider {
  produceOutline(problem: string, ctx: RepoContext): Promise<WalkthroughOutline>;
  hydrateStep(step: OutlineStep, current: FileState, session: SessionCtx): Promise<HydratedStep>;
  /** Optional read-only follow-up chat about the current step. */
  answerQuestion?(question: string, contextText: string, ctx: RepoContext): Promise<string>;
}
