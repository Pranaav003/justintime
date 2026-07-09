/**
 * Core domain contracts for JustInTime. These are the interface between the
 * AI engine (which produces outlines and hydrated steps), the orchestrator
 * (which sequences them), and the UI (which renders them). See design doc
 * Section 4.
 */

export type ChangeKind = 'edit' | 'create' | 'delete' | 'rename';

/** Canonical step states (design Section 9). Single source of truth. */
export type StepState =
  | 'pending'
  | 'navigating'
  | 'hydrating'
  | 'explaining'
  | 'waiting_for_apply'
  | 'applying'
  | 'confirmed'
  | 'skipped'
  | 'reviewing'
  | 'paused'
  | 'conflict'
  | 'error';

export interface RelatedFile {
  file: string;
  relationship: string;
}

export interface HighlightRange {
  file: string;
  startLine: number;
  endLine: number;
  note: string;
}

export interface OutlineStep {
  stepNumber: number;
  title: string;
  /** Relative to workspace root; may not exist yet (create steps). */
  targetFiles: string[];
  /** stepNumbers that must precede this one. */
  dependsOn: number[];
  changeKind: ChangeKind;
  /** The pattern/concept in general (markdown). */
  genericExplanation: string;
  /** Why it matters in this codebase (markdown). */
  specificExplanation: string;
  prerequisites?: string[];
  relatedFiles?: RelatedFile[];
}

/** The model's structured output for the outline phase (sessionId is attached by us). */
export interface OutlinePayload {
  problemSummary: string;
  steps: OutlineStep[];
}

export interface WalkthroughOutline extends OutlinePayload {
  /** SDK session id, used for lazy hydration + follow-up questions. */
  sessionId: string;
}

/** A single edit region, located by surrounding context rather than absolute line numbers. */
export interface AnchoredHunk {
  contextBefore: string;
  oldText: string;
  newText: string;
  contextAfter: string;
  /** Hint only; anchoring matches on context + oldText, not this. */
  advisoryStartLine?: number;
}

export type HazardKind = 'skip-conflict' | 'interaction';

export interface Hazard {
  kind: HazardKind;
  message: string;
  relatedSteps: number[];
}

export interface StepVerification {
  command?: string;
  expectedOutcome: string;
  rollbackInstructions: string;
}

export interface StepNavigation {
  file: string;
  /** 1-based, inclusive, advisory (see design Section 4). */
  startLine: number;
  endLine: number;
}

/** The model's structured output for hydrating one step (hazards are added later by the orchestrator). */
export interface HydratedStepPayload {
  stepNumber: number;
  primaryFile: string;
  changeKind: ChangeKind;
  /** Required when changeKind === 'rename'. */
  renameTo?: string;
  /** For 'edit'. */
  hunks?: AnchoredHunk[];
  /** For 'create'. */
  fullFileContent?: string;
  navigation: StepNavigation;
  highlightRanges?: HighlightRange[];
  verification?: StepVerification;
}

export interface HydratedStep extends HydratedStepPayload {
  /** Empty in MVP; populated by V2 interaction testing. */
  hazards: Hazard[];
}

/** Result of applying a step's change to the workspace (defined here to stay VS Code-free). */
export type ApplyOutcome =
  | { status: 'applied' }
  | { status: 'conflict'; reason: string }
  | { status: 'error'; message: string };
