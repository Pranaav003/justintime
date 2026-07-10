/**
 * Typed message contract between the extension host and the webview client.
 * Both directions are exhaustive discriminated unions so neither side can send
 * an unhandled message. Shared by panel.ts (host) and client.ts (webview).
 */

import type { WalkthroughMode } from '../types';

export type StepDotStatus = 'done' | 'skipped' | 'current' | 'upcoming';

export interface DiffHunkView {
  oldText: string;
  newText: string;
}

/** Everything the client needs to render one step. Markdown fields are sanitized client-side. */
export interface StepView {
  stepNumber: number;
  totalSteps: number;
  title: string;
  locationLabel: string; // e.g. "src/config/database.ts:24-31"
  locationFile: string;
  locationLine: number;
  genericMarkdown: string;
  specificMarkdown: string;
  prerequisites: string[];
  relatedFiles: { file: string; relationship: string }[];
  changeKind: string;
  diffHunks: DiffHunkView[];
  reviewMode: boolean;
  showPrerequisites: boolean;
  dots: StepDotStatus[];
  mode: WalkthroughMode;
}

export type HostToWebview =
  | { type: 'render'; view: StepView }
  | { type: 'busy'; message: string }
  | { type: 'progress'; text: string }
  | { type: 'idle'; message: string }
  | { type: 'applied'; stepNumber: number }
  | { type: 'conflict'; stepNumber: number; reason: string }
  | { type: 'error'; message: string }
  | { type: 'completed'; applied: number; skipped: number; mode: WalkthroughMode }
  | { type: 'answer'; id: number; answer: string }
  | { type: 'answerError'; id: number; message: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'apply' }
  | { type: 'skip' }
  | { type: 'pause' }
  | { type: 'cancel' }
  | { type: 'ask'; id: number; question: string }
  | { type: 'reviewStep'; stepNumber: number }
  | { type: 'openLocation'; file: string; line: number };
