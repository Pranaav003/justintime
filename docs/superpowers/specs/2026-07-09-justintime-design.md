# JustInTime — Revised Design (post-pressure-test)

**Date:** 2026-07-09
**Status:** Design for approval
**Supersedes:** `docs/codeflow-spec-v1.md` (original product spec)

This document is the corrected, buildable design for JustInTime, an AI-powered guided code-walkthrough VS Code extension. It folds in the confirmed findings from an adversarial pressure-test of the original spec (66 confirmed findings, 12 blockers) plus authoritative Claude Agent SDK facts. Product intent (Sections I of the original spec) is unchanged; the mechanism is substantially corrected.

---

## 0. What changed from v1, and why

| # | v1 said | Reality / fix | Severity |
|---|---|---|---|
| 1 | Package `@anthropic-ai/claude-code`, driven via `child_process.spawn`, parse stdout | That package is the **CLI binary**. Use the library **`@anthropic-ai/claude-agent-sdk`** via the in-process **`query()`** async generator. | blocker |
| 2 | "Intercept tool calls to block Write/Edit" | Not a primitive. Use `allowedTools: ['Read','Glob','Grep']` + `disallowedTools: ['Write','Edit','MultiEdit','Bash']` + `permissionMode: 'dontAsk'`. Disallowed tools are removed from the model's context. | blocker |
| 3 | Parse free-form output as strict JSON, hand-retry on failure | Use first-class **structured output**: `outputFormat: { type:'json_schema', schema }` → validated `message.structured_output`, auto-retry, `error_max_structured_output_retries` on repeated failure. | blocker |
| 4 | Auth relies on "claude.ai login" | Inherit the user's existing local `claude`/env credentials automatically; fall back to `ANTHROPIC_API_KEY` stored in VS Code **SecretStorage**. Do not build a claude.ai-login flow. | major |
| 5 | Generate the **whole plan up front** with exact line numbers + `oldContent` + `fullFileContent` | Causes line-drift, forward-references to not-yet-created code, output-token overflow, UI blocking, and self-firing conflict detection. **Replaced with outline-first + lazy per-step hydration** (Section 3). | blocker cluster |
| 6 | Diff-engine writes to disk via `fs` | File may be open + dirty → "changed on disk" conflicts. Use **`WorkspaceEdit` / `workspace.applyEdit`**. | major |
| 7 | "Inline red/green diff in the main editor" | Not a public VS Code API. Use the **native diff editor** (`vscode.diff` over virtual documents via a `TextDocumentContentProvider`). | major |
| 8 | `oldContent` string match, no anchor, no encoding rules | Add **content anchoring** (unique surrounding context), CRLF/whitespace normalization, and multi-hunk support. Line numbers are **advisory only**. | major |
| 9 | Rollback stored **in memory only** | Lost on reload/crash → Revert All silently no-ops. **Persist snapshots** (SecretStorage-adjacent `workspaceState` index + on-disk snapshot files under the extension's `globalStorageUri`). | major |
| 10 | Markdown → `innerHTML`, no CSP | XSS from model output and from workspace file content. Add **CSP + nonce**, sanitize with `marked`+`DOMPurify`, `localResourceRoots`, `asWebviewUri`. | blocker |
| 11 | State machine: UPPERCASE table vs lowercase `StepState`, undocumented `pending`, no error/conflict states, `RevealType.InCenter` | Reconciled canonical lowercase states; added `error`/`conflict`; defined `reviewing` re-entry; correct enum is `TextEditorRevealType.InCenter`. | major |
| 12 | Conflict detection = compare current vs `oldContent` | Fires on the extension's **own** edits. Distinguish own vs external by tracking **expected post-edit content**. | major |

The 6 refuted findings and 2 uncertain findings are not incorporated. Full findings archive: workflow run `wf_d249760f-e84`.

---

## 1. Architecture (corrected)

Four layers, single responsibility each.

| Layer | Technology | Responsibility |
|---|---|---|
| **AI Engine** | `PlanProvider` seam; MVP impl = `@anthropic-ai/claude-agent-sdk` (`query()`) | Read-only codebase analysis; produce a walkthrough **outline**; on demand, **hydrate** one step's anchored diff against current file state; answer mid-step questions (session `resume`). Model provider is swappable (Section 2.1) — built for Claude, others pluggable. |
| **Orchestrator** | TypeScript (extension host) | Step state machine, sequencing, lazy-hydration scheduling, conflict gating, rollback bookkeeping. **PlanSource** abstraction (seam for V2 tournament). |
| **UI Layer** | VS Code Webview | Explanation panel, progress, action buttons, message contract (with ACKs), sanitized markdown, CSP/nonce. |
| **Editor Bridge** | VS Code Extension API | Open/scroll/reveal, decoration lifecycle, native diff editor, `WorkspaceEdit` apply, scoped file watching with self-edit suppression. |

Module map (`src/`): `extension.ts`, `orchestrator.ts`, `claude-bridge.ts`, `editor-bridge.ts`, `diff-engine.ts`, `rollback-store.ts`, `plan-source.ts` (interface + `SingleOutlinePlanSource`), `types.ts`, `prompt-templates.ts`, `webview/` (`panel.ts`, `panel.html`, `panel.css`, `panel.ts`→bundled `panel.js`). ESM (`"type":"module"`).

---

## 2. SDK integration (`claude-bridge.ts`)

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const READONLY = {
  allowedTools: ['Read', 'Glob', 'Grep'],
  disallowedTools: ['Write', 'Edit', 'MultiEdit', 'Bash', 'NotebookEdit'],
  permissionMode: 'dontAsk' as const,
  systemPrompt: { type: 'preset', preset: 'claude_code',
    append: OUTLINE_SYSTEM_APPEND },      // see prompt-templates
  cwd: workspaceRoot,
};
```

- **Outline call:** `query({ prompt, options: { ...READONLY, outputFormat: { type:'json_schema', schema: OUTLINE_JSON_SCHEMA } } })`. Iterate messages; on the terminal `result` message check `subtype === 'success'` and read `structured_output`; on `error_max_structured_output_retries` surface an error state. Capture `session_id`.
- **Hydration call (per step, JIT):** `query({ prompt: hydratePrompt(step, currentFileState), options: { ...READONLY, resume: sessionId, outputFormat: { type:'json_schema', schema: HYDRATED_STEP_SCHEMA } } })`. Resuming keeps the analysis context warm.
- **Mid-step Q&A (V2):** `query({ prompt: question, options: { resume: sessionId } })`, stream text into a chat sub-panel.
- **No file contents embedded in the outline** (SDK guidance): outline references files + line ranges; the extension reads bytes itself.
- **Auth:** SDK inherits local credential resolution automatically. On activation, if a probe `query` fails auth, prompt for `ANTHROPIC_API_KEY` → `context.secrets.store('justintime.anthropicApiKey', …)` and inject into the child env. Never build a claude.ai-login flow.
- **Timeouts:** outline > 120 s → "Still working…"; > 300 s → offer cancel (`AbortController`). Hydration has a shorter budget (per-step, ~60 s).

---

### 2.1 Model provider abstraction (seam; MVP = Claude only)

JustInTime is **built for Claude** but the model is swappable behind a `PlanProvider` interface, so an Anthropic-Messages-API / OpenAI / other backend can be added without touching the orchestrator or UI.

```ts
interface PlanProvider {
  produceOutline(problem: string, ctx: RepoContext): Promise<WalkthroughOutline>;
  hydrateStep(step: OutlineStep, current: FileState, session: SessionCtx): Promise<HydratedStep>;
  answerQuestion?(question: string, session: SessionCtx): AsyncIterable<string>;   // V2 Q&A
}
```

- **MVP: `ClaudeAgentProvider`** (default, first-class) wraps `@anthropic-ai/claude-agent-sdk` `query()`. Claude is the only provider that gets the read-only exploration tools (Read/Glob/Grep), structured output, and session resume **for free** from the SDK — that is precisely why the product is "meant for Claude."
- **Future providers** (`AnthropicMessagesProvider` on the raw Messages API, `OpenAIProvider` for GPT, etc.) implement the same interface but must supply their own small **codebase-tools adapter** (glob/grep/read tool-loop) plus JSON-mode/function-calling for structured output. The outline/hydration **prompts and JSON schemas are provider-independent** — only the transport + tool-loop differ — so this is a genuinely thin seam.
- Selected via setting `justintime.provider` (default `claude-agent-sdk`). MVP ships only `claude-agent-sdk`; the others are documented, not built.

---

## 3. Core loop: outline-first, lazy hydration (the key design)

**Phase A — Outline (once, up front, fast).** Claude returns a lightweight ordered `WalkthroughOutline`: per step a title, target file(s), dependency edges, and dual explanations — **no diffs, no absolute line numbers as truth.** Shown to the user immediately as the progress plan.

**Phase B — Hydrate + present (per step, just-in-time).** When step *k* activates, the orchestrator:
1. Reads the **current** content of the target file(s).
2. Asks Claude to produce step *k*'s concrete diff **against that current state**, returned as **anchored hunks** (Section 5).
3. Editor bridge navigates + highlights; webview renders explanation + native diff.
4. On **Apply**, `diff-engine` applies the `WorkspaceEdit`, records the snapshot + expected post-edit content, advances.

Why this dissolves the v1 blockers: diffs are always generated against *current* reality, so **line-drift and forward-references to not-yet-created code cannot occur**; output stays small (**no token overflow**); the user sees the outline in seconds (**no UI block**); and conflict detection compares against **expected** content, so it **never self-fires**.

**Seam for V2 (per your "MVP clean; design the seams" decision):** Phase A is produced by a `PlanSource`. MVP ships `SingleOutlinePlanSource`. `TournamentPlanSource` (V2) implements the same interface — generates K candidate outlines via parallel subagents, scores them, returns the winner — with zero orchestrator changes. `HydratedStep` carries an optional `hazards: Hazard[]` field (empty in MVP) that a V2 interaction-testing pass fills. See Section 12.

---

## 4. Data contracts (`types.ts`, hardened)

```ts
interface WalkthroughOutline {
  sessionId: string;              // SDK session id, for hydration + Q&A
  problemSummary: string;
  steps: OutlineStep[];           // ordered; length is the source of truth (no separate totalSteps)
}

interface OutlineStep {
  stepNumber: number;             // 1-based, contiguous
  title: string;
  targetFiles: string[];          // relative to workspace root; may not exist yet (create steps)
  dependsOn: number[];            // stepNumbers that must precede this
  changeKind: 'edit' | 'create' | 'delete' | 'rename';
  genericExplanation: string;     // markdown
  specificExplanation: string;    // markdown
  prerequisites?: string[];
  relatedFiles?: { file: string; relationship: string }[];
}

interface HydratedStep {
  stepNumber: number;
  primaryFile: string;
  changeKind: 'edit' | 'create' | 'delete' | 'rename';
  renameTo?: string;              // required when changeKind==='rename'
  hunks?: AnchoredHunk[];         // for 'edit'
  fullFileContent?: string;       // for 'create'
  navigation: { file: string; startLine: number; endLine: number };  // 1-based, inclusive, ADVISORY
  highlightRanges?: { file: string; startLine: number; endLine: number; note: string }[];
  verification?: { command?: string; expectedOutcome: string; rollbackInstructions: string };
  hazards?: Hazard[];             // empty in MVP; filled by V2 interaction testing
}

interface AnchoredHunk {
  contextBefore: string;          // N lines of unique context preceding the change
  oldText: string;                // exact text to replace (normalized comparison)
  newText: string;
  contextAfter: string;           // N lines of unique context following the change
  advisoryStartLine?: number;     // hint only; anchor by context+oldText match
}

interface Hazard { kind: 'skip-conflict' | 'interaction'; message: string; relatedSteps: number[]; }
```

Conventions made explicit (v1 left these ambiguous): line numbers **1-based, inclusive, advisory**; encoding UTF-8; comparisons normalize CRLF→LF and are trailing-whitespace-tolerant per Section 5. `verification.command` is **not** auto-run in MVP (deferred; see Section 11) — arbitrary-shell hazard avoided.

---

## 5. Diff application & anchoring (`diff-engine.ts`)

- **Anchor, don't trust line numbers.** Locate a hunk by finding the unique occurrence of `contextBefore + oldText + contextAfter` in the current file (normalized: CRLF→LF, tabs preserved, trailing whitespace tolerated). 0 matches → conflict/error; >1 match → request re-hydration with more context.
- **Apply via `WorkspaceEdit`**, not `fs.writeFile`, so open/dirty buffers stay consistent and undo integrates with VS Code. `create` → `WorkspaceEdit.createFile` + insert; `delete` → `deleteFile`; `rename` → `renameFile` (uses `renameTo`).
- **Record expected post-edit content** per file after each apply — this is what conflict detection compares against, so the extension's own edits never register as conflicts.
- **Multi-hunk** steps are applied atomically (all-or-nothing) within one `WorkspaceEdit`.

---

## 6. Rollback (`rollback-store.ts`, persisted)

- Before each apply, snapshot the **complete original file content** (per file, per step) to `context.globalStorageUri/snapshots/<sessionId>/<step>-<hash>.snap`, with an index in `workspaceState`.
- **Revert All** restores every touched file to its pre-walkthrough state in **reverse apply order**; survives reload/crash/window-close because snapshots are on disk.
- **Step-level revert** (V2) restores a single step's snapshot only if no later applied step's anchors depend on it (checked by re-anchoring, not by undecidable static analysis).

---

## 7. Editor bridge (`editor-bridge.ts`)

- **Navigate:** `await window.showTextDocument(uri)`, then `editor.revealRange(range, TextEditorRevealType.InCenter)` — awaited in sequence to avoid the scroll race.
- **Decorations:** target range = `justintime.highlightColor` (#FFF3CD); maintained across tab switches by re-applying on `window.onDidChangeActiveTextEditor` / `visibleTextEditors` changes (decorations are per-editor and otherwise lost). Cleared on step advance.
- **Diff view:** native diff editor — register a `TextDocumentContentProvider` for a `justintime-diff:` scheme exposing before/after virtual docs, open with `vscode.diff`. Inline vs side-by-side follows the diff editor's own native toggle (satisfies `justintime.diffStyle` without a custom overlay).
- **File watching:** scoped `createFileSystemWatcher` on target files only; **suppress events for the extension's own writes** (compare against expected content / a short write-guard window) so watcher self-triggering doesn't create phantom conflicts.

---

## 8. Webview & security (`webview/`)

- **CSP + nonce** in `panel.html`: `default-src 'none'; script-src 'nonce-<n>'; style-src ${webview.cspSource} 'nonce-<n>'; img-src ${webview.cspSource};`. `localResourceRoots` limited to `dist/` + `media/`; all local refs via `webview.asWebviewUri`.
- **Sanitize all model/file-derived HTML:** render markdown with `marked`, then `DOMPurify.sanitize` with an allowlist (no `style`, no event handlers); diff content is escaped before insertion.
- **Message contract** (typed, both directions) with **ACKs**: `apply` → host applies → posts `applied` (or `conflict`/`error`) → panel advances. No fire-and-forget for the APPLYING→CONFIRMED transition.
- **Persistence:** `retainContextWhenHidden: true` + `getState/setState` so step state survives hide/show.
- **Review mode enforced host-side:** clicking a completed step dot re-renders read-only and the host **rejects** any `apply` while in review; future/in-progress dots are non-navigational.
- `acquireVsCodeApi()` called exactly once, kept module-private.

---

## 9. State machine (`orchestrator.ts`, reconciled)

Canonical lowercase states (single source of truth): `pending → navigating → hydrating → explaining → waiting_for_apply → applying → confirmed`, plus `skipped`, `reviewing`, `paused`, `conflict`, `error`.

- `hydrating` is the new JIT step (Section 3). `applying` has an explicit async fence: it only reaches `confirmed` after `workspace.applyEdit` resolves **and** post-edit content is verified.
- `conflict` (entered from `navigating`/`hydrating`/pre-apply when anchoring fails or external edit detected) offers: **re-hydrate** (regenerate against current state), **skip**, **force-apply**.
- `error` (SDK failure, auth failure, max-retries) offers restart/cancel.
- `reviewing` is a read-only visit to a completed step; exiting returns to the previously active step; no re-apply.
- `skipped` records skip; if a later step's anchor then fails, that surfaces as a `conflict` on that step with a `skip-conflict` hazard note (this is the MVP's minimal answer to the v1 "skip has no conflict model" gap).

---

## 10. Conflict handling (minimal, MVP — not deferred)

The pressure-test showed conflict handling **cannot** be fully deferred to V2 as v1 implied, because lazy hydration + skip make some conflicts intrinsic. MVP includes exactly: anchor-failure detection, external-edit detection (expected-content compare), and the three-way resolution (`re-hydrate` / `skip` / `force`). Full re-analysis-from-here and step-level revert remain V2.

---

## 11. Commands, settings, MVP scope

**Commands:** `justintime.start`, `.pause`, `.resume`, `.skip`, `.revertAll`. (`.export` → V2.)
**Settings:** `diffStyle` (inline|split, default inline), `autoNavigate` (true), `showPrerequisites` (true), `highlightColor` (#FFF3CD), `secondaryHighlightColor` (#D1ECF1), `maxSteps` (30), `contextLines` (anchor context size, default 3).

**MVP ships:** `justintime.start`; SDK outline generation; lazy per-step hydration; explanation panel (dual explanations, progress dots, location badge, sanitized markdown); auto-navigation + target highlight; native diff view per step; Apply/Skip/Pause; minimal conflict handling (Section 10); persisted Revert All.

**Explicitly deferred:** mid-step chat; secondary highlight split editors; export to Markdown; auto-run verification commands; step-level revert; full re-analysis; and all combinatorial features (Section 12).

---

## 12. Seams for the combinatorial "best-solution" future (V2/V3, designed not built)

Per the scope decision, MVP is linear but leaves clean seams; this section is the spec for later.

- **`PlanSource` interface** (already in MVP): `produceOutline(problem, ctx): Promise<WalkthroughOutline>`. MVP = `SingleOutlinePlanSource`.
- **V2 `TournamentPlanSource`** — generate K candidate outlines via parallel subagents with diverse lenses (minimal-diff / idiomatic / defensive / perf), score each by objective signals (compiles? existing tests pass? lint?) + a judge-agent design review, return the winner (optionally grafting runner-up ideas). No decision-diagram machinery needed at this scale. Implements the same interface → zero orchestrator change.
- **V2 interaction testing** — for the chosen outline, build a **t-way covering array** over the steps (Boolean vars), and for each selected combination run a subagent in a **throwaway git worktree** (`isolation:'worktree'`), apply that subset, run the test suite, record emergent failures. Populate `HydratedStep.hazards` (`skip-conflict`/`interaction`) surfaced in the panel, and optionally bank a guard/test into the codebase.
- **V3 BDD/ZDD substrate** — only when the space stops being enumerable, or for cross-session persistence/query, or to reuse impact analysis: represent the **family of safe step-subsets as a ZDD** and the **safety predicate as a BDD**, integrated with the existing `bdd-patch-impact` MCP server (impact-guided combination selection instead of blind t-way sampling) and `zopen`/tree-compression assets. Extract the optimal subset via weighted traversal. This is the "pick the absolute best solution" endgame — deliberately kept out of MVP as fancy-hammer risk at 30-step linear scale.

---

## 13. Delivery surfaces: the extension is the shell; a plugin/skill is a text-native companion

**The full product must be a VS Code extension.** Custom webview panels, the gated "Apply & Next" button, editor navigation/scroll/reveal, decoration highlights, and the native diff editor are **exclusively `vscode.*` Extension-API capabilities.** A Claude Code **plugin** (a `plugin.json` manifest bundling skills / subagents / hooks / MCP servers / LSP servers / commands) and a Claude **skill** (instruction markdown + optional scripts) have **zero reach** into the VS Code API — they run inside Claude's agent loop as a separate OS process. Neither can deliver JustInTime's core UX on its own. *(Confirmed against current Claude Code plugin/skill capabilities.)*

What a plugin/skill *can* deliver is a **text/chat-native subset** — same methodology, no rich UI:
- `skills/jit-start` → `/jit-start <topic>` invokes a read-only `jit-planner` **subagent** that produces the outline in chat.
- `skills/jit-next` → `/jit-next` hydrates the next step's diff against current file state, dual-explains it, applies via Claude's own Edit tool on confirmation.
- `skills/jit-status` → text progress; step state in a scratch file. Gating is conversational (type the next command), not a button.
- Value: runs JustInTime **outside VS Code** (CLI / web / CI) and shares the planner subagent + prompts with the extension.

**Optional hybrid (V2/V3 seam) — MCP bridge:** the extension hosts a local MCP server (the same pattern Anthropic's built-in `ide` server uses — `127.0.0.1`, token in `~/.claude/ide/`) exposing editor-control tools (`jit_open_panel`, `jit_show_step`, `jit_highlight_range`, `jit_apply_diff`, `jit_advance_step`). A companion plugin bundles that server config + the skills; **Claude is the orchestration brain, the extension is the UI actuator, MCP is the IPC.** It degrades gracefully to text-native mode when the extension isn't running.

**MVP = VS Code extension only.** The companion plugin/skill and the MCP bridge are documented seams, not MVP scope. To keep them cheap later, the MVP already factors the provider-independent prompts + the `PlanProvider`/planner logic so a plugin subagent can reuse them verbatim.

---

## 14. Testing

- **Unit (no VS Code dep):** state-machine transitions; JSON-schema validation of outline/hydrated-step; **anchoring** (0/1/many matches, CRLF, trailing whitespace, multi-hunk); rollback ordering.
- **Integration (mock VS Code API + fixture repos):** claude-bridge message handling incl. `error_max_structured_output_retries`; editor-bridge `WorkspaceEdit`/decoration/diff; conflict detection own-vs-external.
- **E2E (VS Code Extension Test Runner):** full walkthrough on a fixture repo — outline → hydrate → apply → revert-all round-trip.

---

## 15. Build & publish

- `@anthropic-ai/claude-agent-sdk` + `marked` + `dompurify` (+ `@types`), dev: `@types/vscode`, `typescript`, `esbuild`, test runner (vitest for unit/integration, `@vscode/test-electron` for E2E). ESM.
- **Two esbuild bundles:** extension host (`--platform=node --external:vscode`) and webview (`--platform=browser`).
- `engines.vscode ^1.95.0`; activation on `onCommand:justintime.start`. Package with `vsce`.
