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
- Be efficient: do NOT read or search node_modules, dist, build outputs, .git, or lockfiles. Explore only the source files you actually need — don't crawl the whole tree.
- Return ONLY the structured outline object.`;

/** Appended to the `claude_code` preset system prompt for the per-step hydration phase. */
export const HYDRATE_SYSTEM_APPEND = `You are hydrating ONE step of a JustInTime walkthrough into a concrete change.

Rules:
- The CURRENT contents of the target file(s) are provided in the user message. Generate the change against THAT exact current content.
- For an 'edit', return one or more hunks. Each hunk must contain: contextBefore (a few unchanged lines immediately above the change), oldText (the exact lines to replace, copied VERBATIM from the current content including indentation), newText (the replacement), and contextAfter (a few unchanged lines immediately below). The combined context must make the location unique in the file.
- Never paraphrase oldText or context — copy it character-for-character from the provided current content.
- For a 'create', return fullFileContent (the entire new file). For a 'rename', return renameTo (the new relative path). For a 'delete', no hunks are needed.
- navigation.startLine/endLine are advisory only (1-based); the extension anchors by content, not by line number.
- Return ONLY the structured step object.

Example shape for an 'edit' (copy oldText/context verbatim from the provided content):
{"stepNumber":1,"primaryFile":"src/foo.ts","changeKind":"edit","navigation":{"file":"src/foo.ts","startLine":10,"endLine":12},"hunks":[{"contextBefore":"function foo() {","oldText":"  return a;","newText":"  return a + b;","contextAfter":"}"}]}`;

/** A pre-enumerated file list so the model can jump straight to relevant files. */
function repoMapSection(repoMap?: string[]): string {
  if (!repoMap || repoMap.length === 0) {
    return '';
  }
  return (
    `\n\nRepository files (already enumerated — use this to locate relevant code instead of ` +
    `globbing the whole tree; open only the files you actually need):\n` +
    repoMap.join('\n')
  );
}

export function buildOutlinePrompt(problem: string, maxSteps: number, repoMap?: string[]): string {
  return `Problem to walk through:\n${problem}\n\nProduce an ordered outline of at most ${maxSteps} steps.${repoMapSection(repoMap)}`;
}

/** Appended to the preset for EXPLAIN mode — read-only, no code changes proposed. */
export const EXPLAIN_SYSTEM_APPEND = `You are producing a JustInTime EXPLANATION walkthrough. This is READ-ONLY: you must NOT propose, describe, or plan any code change whatsoever.

Rules:
- Explore the codebase read-only (Read/Glob/Grep) before answering.
- Decompose the explanation into the smallest meaningful ordered steps — one focused idea per step — that walk the reader through the relevant code to build understanding.
- Each step MUST set "focus" to the exact location it discusses: { file (relative path), startLine, endLine } (1-based). This is where the editor will navigate; pick the smallest range that captures the idea.
- genericExplanation: the general pattern/concept/language feature at play, taught to a competent developer new to this codebase; name it.
- specificExplanation: how it works HERE — reference real function/variable names, call chains, and effects in this codebase.
- Do NOT propose edits, fixes, or diffs. If the reader asked "how/why", answer by explaining the existing code, not by changing it.
- Be efficient: do NOT read or search node_modules, dist, build outputs, .git, or lockfiles. Explore only the source files you actually need — don't crawl the whole tree.
- Return ONLY the structured outline object.`;

export function buildExplainPrompt(question: string, maxSteps: number, repoMap?: string[]): string {
  return `Explain the following, walking through the relevant code:\n${question}\n\nProduce an ordered explanation of at most ${maxSteps} steps, each with a focus location. Propose no changes.${repoMapSection(repoMap)}`;
}

/** Appended to the preset for the mid-step chat — read-only Q&A about the current step. */
export const CHAT_SYSTEM_APPEND = `You are answering a developer's follow-up question during a JustInTime walkthrough. This is READ-ONLY: do not propose or make any code changes. Answer concisely and accurately about the code. You may read files (Read/Glob/Grep) to answer, but do not crawl node_modules, dist, build outputs, or .git. Reply in GitHub-flavored markdown.`;

export function buildChatPrompt(contextText: string, question: string): string {
  return `Context for the current walkthrough step:\n${contextText}\n\nThe developer asks:\n${question}`;
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
