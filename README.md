# JustInTime

**AI-guided, step-by-step code walkthroughs for VS Code.** Describe a problem; JustInTime uses your selected provider to decompose it into ordered steps, navigate you to each change, explain *what* it does (the pattern) and *why here* (this codebase), show a diff, and wait for your **Apply & Next** before landing anything.

Supports the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), OpenAI-compatible endpoints, and an installed Codex CLI. JustInTime keeps you in the loop and teaches the code as you change it.

## How it works

1. **Outline first.** Your selected provider analyzes your codebase read-only and returns a lightweight, dependency-ordered plan — shown immediately.
2. **Lazy hydration.** Just before each step, JustInTime asks the provider for that step's concrete diff *against the current file state*, anchored by surrounding context rather than fragile line numbers. Anchors are validated before applying, so line-number drift or an earlier step's edits do not silently retarget a change — the "just in time" in the name.
3. **Gated apply.** Each change is a gate: navigate → explain (twice) → diff → **Apply & Next** / **Skip** / **Pause**. Each file’s first preimage is durably snapshotted before applying, for an explicit **Revert All**.

## Providers

Run **“JustInTime: Set Provider & API Key”** to choose a provider. API keys, where needed, stay in VS Code SecretStorage:

- **Claude (Agent SDK)** — default, first-class. Uses your `claude` login or `ANTHROPIC_API_KEY`; gets read-only codebase tools for free.
- **OpenAI** — `api.openai.com`; needs an API key + model (e.g. `gpt-4o`).
- **Ollama** — local `localhost:11434`; usually no key, just a model (e.g. `llama3.1`).
- **Custom** — any OpenAI-compatible `/v1` endpoint (base URL + key + model).
- **Codex CLI** — your installed Codex CLI and existing ChatGPT login; uses your Codex account usage. The accepted configuration is CLI **0.156.1**, **`gpt-6-sol`**, and **medium reasoning**, with no API key needed.

OpenAI-compatible and Codex providers obtain source through VS Code read/search callbacks. Codex uses fresh read-only CLI completions with native commands and integrations disabled; the extension executes its file requests. Solve still waits for **Apply & Next**.

The Codex preset and blank-model fallback use the accepted **`gpt-6-sol` with medium reasoning**. Missing, empty, or whitespace-only Codex model settings use Sol; deliberate nonblank model overrides are preserved. Luna's medium-reasoning result of **24/25** did not meet the acceptance bar; Luna and the tested local models remain unaccepted. The overall default provider and other provider defaults are unchanged.

Switching from another provider to Codex CLI selects the Sol preset. Reselecting Codex preserves the effective model setting and its configuration scope. To explicitly pin the accepted model, add or update this entry in VS Code Settings (JSON), preserving your other settings:

```json
{
  "justintime.model": "gpt-6-sol"
}
```

A deliberate workspace model setting takes precedence over the user setting. To return to the accepted default while already using Codex, clear the effective model setting or set it to `gpt-6-sol`; reselecting Codex leaves that setting intact. The adapter fixes reasoning effort at medium; no separate reasoning setting or API key is needed for this path.

## Requirements

- **For Claude:** the Claude Code CLI (`claude`) installed and authenticated — JustInTime uses your existing login (or `ANTHROPIC_API_KEY`) and your installed CLI rather than bundling one. Install from https://code.claude.com and run `claude` once to log in.
- **For OpenAI/Ollama/custom:** an API key (or a running Ollama) and a model name, set via the command above.
- **For Codex CLI:** macOS or Linux with Codex CLI installed and signed in through ChatGPT. Tested with CLI `0.156.1`. If discovery fails, set the machine-level `justintime.codexExecutable` to its absolute path; workspace overrides are ignored.

## Two modes

Pick explicitly — JustInTime never guesses whether you want changes:

- **Solve** — proposes gated code changes, step by step (Apply / Skip each).
- **Explain** — *read-only.* Walks you through the relevant code and explains it (concept + this codebase), with a **Next** button and no diffs. It cannot modify anything.

## Commands

- **JustInTime: Start Walkthrough** — pick Solve or Explain, then describe your problem/question
- **JustInTime: Explain (read-only)** / **JustInTime: Solve** — skip the picker
- **Pause / Resume / Skip Step / Revert All**
- **JustInTime: Set Provider & API Key** — choose a provider; store an API key when that provider needs one

## Walkthrough panel

The panel follows VS Code's fonts and theme colors, including light, dark, and high-contrast themes. Numbered step buttons show progress and let you review prepared steps with the keyboard. Explanations, file locations, and the proposed change have separate sections; long code scrolls within its own region.

Follow-up questions have a labelled field and an explicit Send button. Drafts stay with their step when you review another step and return. Explain and review remain read-only; Solve requires **Apply & Next** for each change. A submitted action stays disabled until the next state arrives. If a step fails or conflicts, the panel shows the reason and directs you to start a new walkthrough rather than offering an unsupported retry.

The interface refresh uses [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) guidance adapted to a native VS Code panel.

## Workspace recovery and cancellation

Editor operations, repository maps, provider read/search callbacks, and recovery targets use the **first workspace folder**. Paths are revalidated at I/O boundaries, including symlink targets; outside targets are rejected. These checks do not provide an operating-system sandbox against an external process racing the final filesystem check.

**Revert All is workspace-wide.** It restores the earliest outstanding preimage of each file across successive walkthroughs, even after the panel closes or VS Code restarts. Starting the extension never automatically restores files. Recovery uses the same serialized queue as snapshot-plus-apply, so an already-entered edit settles before recovery runs. Failed restores remain available for retry; successfully restored entries retire. Legacy session snapshot directories are left untouched.

Snapshots capture unsaved editor text when present. Revert restores that text into open documents and saves it to disk, preserving the user's pre-change text and preventing a later save from bringing generated text back.

Cancel permanently ends the current walkthrough. Closing/replacing its panel or deactivating the extension aborts pending provider work silently; late answers, progress, and retained read/search callbacks cannot continue the old walkthrough. An editor mutation already underway remains recoverable. Pause and review remain reversible within a live walkthrough.

## Settings

| Setting | Default | Description |
|---|---|---|
| `justintime.diffStyle` | `inline` | Diff display mode (`inline` / `split`) |
| `justintime.autoNavigate` | `true` | Open + scroll to the target file each step |
| `justintime.showPrerequisites` | `true` | Show the prerequisites section |
| `justintime.highlightColor` | `rgba(88,166,255,0.15)` | Target range highlight (translucent; calm blue by default) |
| `justintime.maxSteps` | `30` | Max steps per walkthrough |
| `justintime.model` | *(blank)* | Pin the provider model; blank Codex model uses accepted `gpt-6-sol` |
| `justintime.claudeExecutable` | *(blank)* | Path to `claude` (blank = auto-detect on PATH) |

## Development

Use Node.js 22.13+ within the 22.x line, or Node.js 24 or newer, for the development dependencies.

```bash
npm ci              # install locked dependencies
npm run verify      # typecheck, tests, baseline ratchet, and both bundles
npm test            # unit + integration (vitest)
npm run build       # esbuild -> dist/
npm run test:e2e     # two isolated VS Code hosts: walkthroughs then explicit recovery
npm run coverage    # V8 coverage under the paired Vitest toolchain
npm audit           # complete dependency advisory check
npm run smoke       # real-Claude provider check (needs ANTHROPIC_API_KEY)
```

Package a source checkout with the locked dependencies and local VSCE:

```bash
npm ci
npm run build
npx --no-install vsce package --out ../justintime-review.vsix
```

Keep VSCE's default dependency inclusion to ship the external Claude Agent SDK and its runtime peers. The checked-in `.vscodeignore` excludes source, local workflow artifacts, and test-only baseline metadata; the recipe uses those rules directly.

The E2E runner copies the fixture into a disposable two-root workspace and uses an isolated profile. It launches a prepare host and a fresh recovery host with shared recovery storage, then removes temporary workspace/profile artifacts in `finally`. Tests cover first-root scope, traversal/symlink rejection, dirty buffers, cancellation, panel closure, repeated edits, and explicit recovery after restart. The runner uses the current `@vscode/test-electron` macOS `Code` executable resolver. A display and a downloadable VS Code build are required.

Development dependencies use paired Vitest/coverage 4.1.12. The narrow `minimatch` override is scoped to `@vscode/vsce`; it was checked against packaging glob cases and a dependency-inclusive VSIX build. Project `.npmrc` enables peer dependency resolution so `npm ci` includes the SDK's required peers.

Press **F5** ("Run JustInTime Extension") to try it in a dev Extension Host.

## Validation

Current source checks pass `npm run typecheck`, `npm test` (**600 tests across 21 files**), and `npm run baseline`. The suite includes 23 added Codex default/reselection checks and the 15 baseline failure-reporting regressions from the preceding cleanup. The historical accepted provider evidence below remains distinct from these current source checks.

The accepted provider run used **Codex CLI 0.156.1 with the existing ChatGPT login, GPT-6 Sol, and medium reasoning**. That `npm run verify` passed **562 automated tests across 20 test files**, TypeScript checking, the baseline check, and both bundles. Independent semantic audits passed **25/25 frozen accuracy cases** and **5/5 actual installed VS Code interactions**: Explain, promise-identity chat, numeric exception chat, Solve/Apply, and Revert.

In the accepted integration checks, Apply changed only the proposed fixture file and passed four runtime assertions. Revert restored all ten original JavaScript filenames and hashes, and all nine original runtime checks passed.

These results cover the tested source and inputs; test-matrix success does not guarantee every model response. Local models and Luna remain unaccepted. OpenAI API-key testing is explicitly deferred; the accepted Codex path uses the existing ChatGPT login without an API key.

## License

MIT
