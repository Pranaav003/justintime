/**
 * Prompts for the two model phases. Provider-independent: the same text is
 * reused by any future PlanProvider or by a companion Claude Code plugin
 * subagent (design Sections 2.1 & 13).
 */

/** Appended to the `claude_code` preset system prompt for the outline phase. */
export const OUTLINE_SYSTEM_APPEND = `You are producing a JustInTime walkthrough OUTLINE for a code problem.

Rules:
- Explore the codebase read-only (Read/Glob/Grep) before proposing anything.
- Decompose the solution into the SMALLEST meaningful ordered steps — one conceptual change per step.
- Order steps by dependency: foundational changes first; a step must never reference code that an earlier step has not yet created.
- Do NOT include diffs, code bodies, or exact line numbers in the outline — only titles, target files, dependency edges (dependsOn), changeKind, and the two explanations. Concrete diffs are generated later, per step, against the live file.
- genericExplanation: teach the pattern/principle/language feature as if to a competent developer who is new to this codebase; name the pattern.
- specificExplanation: reference actual file paths and real function/variable names in THIS codebase, plus downstream effects.
- Return ONLY the structured outline object.`;

/** Appended to the `claude_code` preset system prompt for the per-step hydration phase. */
export const HYDRATE_SYSTEM_APPEND = `You are hydrating ONE step of a JustInTime walkthrough into a concrete change.

Rules:
- The CURRENT contents of the target file(s) are provided in the user message. Generate the change against THAT exact current content.
- For an 'edit', return one or more hunks. Each hunk must contain: contextBefore (a few unchanged lines immediately above the change), oldText (the exact lines to replace, copied VERBATIM from the current content including indentation), newText (the replacement), and contextAfter (a few unchanged lines immediately below). The combined context must make the location unique in the file.
- Never paraphrase oldText or context — copy it character-for-character from the provided current content.
- For a 'create', return fullFileContent (the entire new file). For a 'rename', return renameTo (the new relative path). For a 'delete', no hunks are needed.
- navigation.startLine/endLine are advisory only (1-based); the extension anchors by content, not by line number.
- Return ONLY the structured step object.`;

export function buildOutlinePrompt(problem: string, maxSteps: number): string {
  return `Problem to walk through:\n${problem}\n\nProduce an ordered outline of at most ${maxSteps} steps.`;
}

import type { OutlineStep } from './types';

export function buildHydratePrompt(step: OutlineStep, currentFiles: Record<string, string>): string {
  const files = Object.entries(currentFiles)
    .map(([path, content]) => `--- BEGIN ${path} (current content) ---\n${content}\n--- END ${path} ---`)
    .join('\n\n');
  const body = files || '(No existing file content supplied; this is likely a create step.)';
  // Hydration is a stateless query (session resume is unreliable across SDK/
  // gateway versions), so restate the step's intent from the outline here.
  return (
    `Hydrate this walkthrough step into a concrete change.\n\n` +
    `Step ${step.stepNumber}: ${step.title}\n` +
    `Change kind: ${step.changeKind}\n` +
    `What this step does (general): ${step.genericExplanation}\n` +
    `Why here (specific): ${step.specificExplanation}\n\n` +
    body
  );
}
