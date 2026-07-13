# JustInTime

**AI-guided, step-by-step code walkthroughs for VS Code.** Describe a problem; JustInTime uses Claude to decompose it into ordered steps, navigate you to each change, explain *what* it does (the pattern) and *why here* (this codebase), show a diff, and wait for your **Apply & Next** before landing anything.

Built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). Unlike autonomous "rewrite five files at once" agents, JustInTime keeps you in the loop and teaches the code as you change it.

## How it works

1. **Outline first.** Claude analyzes your codebase read-only and returns a lightweight, dependency-ordered plan — shown immediately.
2. **Lazy hydration.** Just before each step, JustInTime asks Claude for that step's concrete diff *against the current file state*, anchored by surrounding context rather than fragile line numbers. This is why it's immune to line-drift and to its own prior edits shifting later steps — the "just in time" in the name.
3. **Gated apply.** Each change is a gate: navigate → explain (twice) → diff → **Apply & Next** / **Skip** / **Pause**. Every applied change is snapshotted for a crash-proof **Revert All**.

## Providers

JustInTime is built for Claude but works with any model. Run **“JustInTime: Set Provider & API Key”** to pick one and store credentials (in VS Code SecretStorage):

- **Claude (Agent SDK)** — default, first-class. Uses your `claude` login or `ANTHROPIC_API_KEY`; gets read-only codebase tools for free.
- **OpenAI** — `api.openai.com`; needs an API key + model (e.g. `gpt-4o`).
- **Ollama** — local `localhost:11434`; usually no key, just a model (e.g. `llama3.1`).
- **Custom** — any OpenAI-compatible `/v1` endpoint (base URL + key + model).

Non-Claude providers explore the code via a `read_files` tool loop (they don't have Claude's built-in file tools), so outline quality depends on the model. Claude remains the most capable.

## Requirements

- **For Claude:** the Claude Code CLI (`claude`) installed and authenticated — JustInTime uses your existing login (or `ANTHROPIC_API_KEY`) and your installed CLI rather than bundling one. Install from https://code.claude.com and run `claude` once to log in.
- **For OpenAI/Ollama/custom:** an API key (or a running Ollama) and a model name, set via the command above.

## Two modes

Pick explicitly — JustInTime never guesses whether you want changes:

- **Solve** — proposes gated code changes, step by step (Apply / Skip each).
- **Explain** — *read-only.* Walks you through the relevant code and explains it (concept + this codebase), with a **Next** button and no diffs. It cannot modify anything.

## Commands

- **JustInTime: Start Walkthrough** — pick Solve or Explain, then describe your problem/question
- **JustInTime: Explain (read-only)** / **JustInTime: Solve** — skip the picker
- **Pause / Resume / Skip Step / Revert All**
- **Set Anthropic API Key** — store a key in VS Code SecretStorage (only needed if you don't use a `claude` login)

## Settings

| Setting | Default | Description |
|---|---|---|
| `justintime.diffStyle` | `inline` | Diff display mode (`inline` / `split`) |
| `justintime.autoNavigate` | `true` | Open + scroll to the target file each step |
| `justintime.showPrerequisites` | `true` | Show the prerequisites section |
| `justintime.highlightColor` | `rgba(88,166,255,0.15)` | Target range highlight (translucent; calm blue by default) |
| `justintime.maxSteps` | `30` | Max steps per walkthrough |
| `justintime.model` | *(blank)* | Pin a Claude model (blank = your default) |
| `justintime.claudeExecutable` | *(blank)* | Path to `claude` (blank = auto-detect on PATH) |

## Development

```bash
npm install
npm test            # unit + integration (vitest)
npm run build       # esbuild -> dist/
npm run test:e2e    # full walkthrough in a headless VS Code Extension Host
npm run smoke       # real-Claude provider check (needs ANTHROPIC_API_KEY)
```

Press **F5** ("Run JustInTime Extension") to try it in a dev Extension Host.

## License

MIT
