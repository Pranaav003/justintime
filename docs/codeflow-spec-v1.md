# CodeFlow — Product Specification (v1, as-received 2026-07-09)

An AI-powered guided code walkthrough VS Code extension powered by the Claude Code SDK. Decomposes any code problem into ordered steps, navigates to relevant files, explains each change with contextual panels, and waits for approval before advancing.

## I. Product Overview

### 1. Problem
AI coding tools operate in two modes: autonomous (make all changes at once) or conversational (explain without acting). Neither teaches the developer what's happening or why. There is no product combining structured explanation with guided navigation and gated execution — walking the developer through a solution one step at a time, opening the right files, explaining both the general pattern and the codebase-specific rationale, and waiting for approval before each change.

### 2. Solution
VS Code extension that turns any code problem into an interactive step-by-step guided walkthrough. Developer describes the problem. Claude Code analyzes the codebase, decomposes the solution into discrete ordered steps, presents each in a dedicated explanation panel. The panel navigates the editor to the exact file and line, explains what will change (general concept + codebase-specific reasoning), shows the diff, and waits for the developer to click "Apply & Next." Only then does the change land and the next step begin.

### 3. Target User
- Developers onboarding onto unfamiliar codebases.
- Junior developers who want to learn *why* a fix works.
- Senior developers reviewing AI-proposed changes wanting structured, reviewable steps.
- Teams using AI coding tools wanting to maintain code comprehension.

### 4. Core Principles
- **Navigation-first.** The tool takes you to the code.
- **Gated execution.** Nothing changes until approved. Each step is a gate.
- **Dual explanation.** Every change explained twice: what the pattern is in general + why it matters here specifically.
- **Linear progression.** Steps are ordered; progress bar; can go back to review; always know where you are.

## II. Architecture

### 1. System Components
| Layer | Technology | Responsibility |
|---|---|---|
| AI Engine | @anthropic-ai/claude-code SDK | Analyzes codebase, decomposes problem into steps, generates explanations and diffs |
| Orchestrator | TypeScript (extension backend) | Manages step state machine, intercepts SDK tool calls, sequences execution |
| UI Layer | VS Code Webview panels | Renders explanation panels, diff views, progress bar, navigation controls |
| Editor Bridge | VS Code Extension API | Opens files, scrolls to lines, highlights ranges, applies edits, watches for file changes |

### 2. Data Flow
1. **Input.** Developer types problem description into command palette or panel.
2. **Analysis.** Orchestrator sends problem + codebase context to Claude Code SDK. SDK analyzes using built-in file read, grep, glob tools.
3. **Plan generation.** Claude returns a structured JSON plan: ordered array of steps, each with target file, line range, explanation (generic + specific), proposed diff.
4. **Step presentation.** Orchestrator feeds Step 1 to UI. Editor bridge opens file, scrolls to line. Explanation panel renders.
5. **Gated apply.** Developer reads, reviews diff, clicks "Apply & Next." Editor bridge applies edit. File watcher confirms change landed.
6. **Advance.** Orchestrator confirms file system state, marks step complete, presents Step N+1. Repeat.

### 3. State Machine
| State | UI Shows | Transitions To |
|---|---|---|
| NAVIGATING | Opening file, scrolling to line | EXPLAINING |
| EXPLAINING | Explanation panel visible, diff preview | WAITING_FOR_APPLY |
| WAITING_FOR_APPLY | "Apply & Next" button active | APPLYING |
| APPLYING | Applying edit, verifying file state | CONFIRMED |
| CONFIRMED | Step marked complete, advance to next | NAVIGATING (next step) |

Additional: from any state → PAUSED (manual pause), SKIPPED (skip without applying), REVIEWING (go back to previous step without re-applying).

## III. Step Schema

### 1. JSON Structure
```typescript
interface WalkthroughPlan {
  problemSummary: string;
  totalSteps: number;
  steps: WalkthroughStep[];
}

interface WalkthroughStep {
  stepNumber: number;
  title: string;
  // Navigation
  targetFile: string;       // relative path from workspace root
  startLine: number;
  endLine: number;
  highlightRanges?: { file: string; startLine: number; endLine: number; note: string; }[];
  // Explanation
  genericExplanation: string;   // the pattern/concept in general
  specificExplanation: string;  // why it matters here in this code
  prerequisites?: string[];
  relatedFiles?: { file: string; relationship: string; }[];
  // Change
  diff: {
    type: 'edit' | 'create' | 'delete' | 'rename';
    oldContent?: string;        // for edits: the existing code
    newContent?: string;        // the proposed replacement
    fullFileContent?: string;   // for creates: the entire new file
  };
  // Verification
  verification?: { command?: string; expectedOutcome: string; rollbackInstructions: string; };
}
```

### 2. Prompt Strategy
System prompt must enforce structured output and dual-explanation depth. Instruct Claude to:
- Read the full codebase structure first (glob/grep) before proposing changes.
- Decompose into smallest meaningful units — one conceptual change per step.
- Order steps by dependency: foundational before dependent; never reference code not yet created.
- genericExplanation: explain the pattern/principle/feature as if teaching a junior; name the pattern.
- specificExplanation: reference actual variable/function names and file paths; explain why this specific code needs this specific change; reference calling code, downstream effects, related tests.
- Include highlightRanges for relevant code in other files (calling function, covering test, type def).
- Return the complete plan as a single JSON object conforming to WalkthroughPlan before any execution.

## IV. UI Specification

### 1. Layout
| Surface | Position | Content |
|---|---|---|
| Explanation Panel | Side panel (right sidebar) | Step title, progress indicator, generic + specific explanation, related files, "Apply & Next" |
| Editor | Main editor area | Target file opened & scrolled to line, change range highlighted; secondary highlights via decorations |
| Diff View | Inline in editor (or split diff) | Before/after comparison; toggle inline vs side-by-side |

### 2. Explanation Panel Detail (Webview, top to bottom)
- **Progress bar.** "Step 3 of 12." Clickable step dots — filled/outlined/dimmed. Click completed step → review mode (read-only, no re-apply).
- **Step title.**
- **Location badge.** Clickable file:line link, e.g. `src/config/database.ts:24-31`. Click re-navigates.
- **What's happening (generic).** Collapsible, expanded by default. Markdown.
- **Why here (specific).** Collapsible, expanded by default. References real names; links to related files (clickable).
- **Related context.** Collapsible, collapsed by default. Other files touched/relevant; each shows path + relationship + clickable.
- **Prerequisites.** Collapsible, collapsed by default. Only shown if step involves possibly-unfamiliar pattern.
- **Diff preview.** Embedded diff. Red/green line-level. Also visible in main editor as inline diff.
- **Action buttons.** Primary "Apply & Next"; Secondary "Skip"; Tertiary "Pause".

### 3. Navigation Behavior (on step activation, in sequence)
1. Open target file — `vscode.window.showTextDocument()`.
2. Scroll to center target range — `editor.revealRange()` with `RevealType.InCenter`.
3. Highlight target range — subtle background (light yellow) via `editor.setDecorations()`.
4. If highlightRanges exist, open those files in split/background tabs, apply secondary decorations (light blue) with tooltip = note.
5. Explanation panel updates simultaneously; panel scrolls to top per new step.

### 4. Completion Screen
- List of all steps with titles and statuses (applied, skipped).
- Total files modified, lines added, lines removed.
- "Run Verification" button — executes verification commands.
- "Revert All" button — undoes all applied changes using stored original content.
- "Export Walkthrough" button — saves full walkthrough as Markdown.

## V. Claude Code SDK Integration

### 1. SDK Setup
Extension uses @anthropic-ai/claude-code as a subprocess, not a direct API call.
```typescript
import { spawn } from 'child_process';
// SDK invoked with structured prompt requesting WalkthroughPlan JSON.
// Extension intercepts tool calls to prevent Claude from directly editing files.
interface CodeFlowSession {
  workspaceRoot: string;
  problemDescription: string;
  plan: WalkthroughPlan | null;
  currentStep: number;
  stepStates: Map<number, StepState>;
}
type StepState = 'pending' | 'navigating' | 'explaining' | 'waiting_for_apply'
  | 'applying' | 'confirmed' | 'skipped' | 'reviewing';
```

### 2. Invocation Flow
1. **Initialize.** Start SDK with workspace root as cwd. System prompt instructs it to output WalkthroughPlan JSON and prohibits direct file edits.
2. **Allow read-only tools.** Read, Glob, Grep, Bash (read-only). Intercept and block Write, Edit, destructive Bash.
3. **Capture plan.** Parse final output as WalkthroughPlan JSON. Validate schema. Retry with correction prompt if invalid.
4. **Execute steps.** Orchestrator takes over. Claude Code no longer active during step execution.
5. **Optional: mid-walkthrough questions.** Re-invoke Claude with step context + question; stream into chat sub-panel.

### 3. Authentication
Relies on developer's existing Claude Code auth (claude.ai login or Anthropic API key). Extension checks for active session on activation; prompts login if none. No separate API key management.

## VI. File Structure & Key Modules
```
codeflow/
├── package.json
├── tsconfig.json
├── src/
│   ├── extension.ts          # Activation, command registration
│   ├── orchestrator.ts       # State machine, step sequencing
│   ├── claude-bridge.ts      # Claude Code SDK invocation, plan parsing
│   ├── editor-bridge.ts      # File opening, scrolling, highlighting
│   ├── diff-engine.ts        # Diff computation, edit application, rollback
│   ├── types.ts              # WalkthroughPlan, WalkthroughStep, etc.
│   ├── prompt-templates.ts   # System prompts for plan generation
│   └── webview/
│       ├── panel.ts / panel.html / panel.css / panel.js
├── test/
│   ├── orchestrator.test.ts / claude-bridge.test.ts / diff-engine.test.ts
│   └── fixtures/
└── media/icon.png
```

Module responsibilities:
- **extension.ts** — Lifecycle, command registration, webview creation. Depends on all.
- **orchestrator.ts** — Step state machine, transitions, ordering. Depends on claude-bridge, editor-bridge, diff-engine.
- **claude-bridge.ts** — SDK process mgmt, prompt construction, plan JSON parse/validate. Depends on types, prompt-templates.
- **editor-bridge.ts** — File nav, scrolling, decorations, split editors. Depends on VS Code API.
- **diff-engine.ts** — Diff from old/new content, apply edits to disk, store originals for rollback. Depends on VS Code workspace API, fs.
- **panel.ts** — Webview creation, message passing. Depends on orchestrator.

## VII. Commands & Configuration

### 1. Commands
| Command ID | Title | Behavior |
|---|---|---|
| codeflow.start | Start Walkthrough | Input box for problem, then analysis |
| codeflow.pause | Pause | Pause, preserve state |
| codeflow.resume | Resume | Resume from current step |
| codeflow.skip | Skip Step | Skip without applying |
| codeflow.revert | Revert All | Roll back all applied changes |
| codeflow.export | Export Walkthrough | Export as Markdown |

### 2. Settings
| Setting | Type | Default | Description |
|---|---|---|---|
| codeflow.diffStyle | inline\|split | inline | Default diff display mode |
| codeflow.autoNavigate | boolean | true | Auto open/scroll to target on each step |
| codeflow.showPrerequisites | boolean | true | Show prerequisites section |
| codeflow.highlightColor | string | #FFF3CD | Target range highlight bg |
| codeflow.secondaryHighlightColor | string | #D1ECF1 | Related code highlight bg |
| codeflow.maxSteps | number | 30 | Max steps per walkthrough |

## VIII. Edge Cases & Error Handling

### 1. File Conflicts
- Before applying each step, compare file's current content against oldContent in diff. If mismatch → conflict.
- On conflict: pause, warn, offer: (a) re-analyze from this point (re-invoke SDK with current file state), (b) skip, (c) force-apply (overwrite).
- Use FileSystemWatcher on all target files to detect external modifications between steps.

### 2. Large Codebases
- SDK handles large codebases via built-in file tools; extension doesn't send whole codebase.
- maxSteps limit (default 30). Break into multiple sessions if needed.
- Loading indicator during analysis; estimated time based on codebase size.

### 3. SDK Failures
- Invalid JSON → retry once with correction prompt.
- Process crash → error panel with restart option.
- Auth failure → redirect to Claude Code login.
- Timeout: >120s show "Still working..."; >300s offer to cancel.

### 4. Rollback
- Before applying any edit, store complete original file content in memory (keyed by file path + step number).
- "Revert All" restores every modified file to pre-walkthrough state, in reverse order.
- Individual step revert: right-click completed step → "Revert This Step." Only works if no subsequent steps depend on it.

## IX. Build, Test & Publish

### 1. Dev Setup
```
npm init -y
npm install @anthropic-ai/claude-code
npm install -D @types/vscode typescript esbuild
# package.json: "engines": {"vscode":"^1.95.0"}, "activationEvents":["onCommand:codeflow.start"], "main":"./dist/extension.js"
npx esbuild src/extension.ts --bundle --outfile=dist/extension.js --external:vscode --platform=node
npm test
```

### 2. Testing
| Type | Scope | Approach |
|---|---|---|
| Unit | State transitions, schema validation, diff computation | Pure function tests, no VS Code dep |
| Integration | Claude Bridge→plan parsing, Editor Bridge→file ops | Mock VS Code API, fixture codebases |
| E2E | Full walkthrough on sample codebase | VS Code Extension Test Runner |

### 3. Publishing
- `vsce package` → .vsix. Publish to Marketplace as "CodeFlow". GIF demo of 3-step walkthrough.

## X. MVP Scope & Future

### 1. MVP (Build This First)
- Single command: codeflow.start with text input.
- Claude Code SDK analysis and plan generation.
- Step-by-step explanation panel with generic + specific explanations.
- Auto-navigation to target files and lines.
- Inline diff preview per step.
- "Apply & Next" / "Skip" buttons.
- Progress bar with step indicators.
- Revert All on completion screen.

### 2. V2 (After MVP)
- Mid-step chat. Highlight ranges (split editors + secondary highlights). Export to Markdown. Verification commands. Conflict resolution (detect manual edits, re-analysis). Step-level revert.

### 3. V3 (Stretch)
- Team walkthroughs (replay in teammate's VS Code). Walkthrough library (save/browse/search past walkthroughs). Adaptive difficulty. Branch integration (branch + commit per step + PR).
