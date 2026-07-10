# JustInTime

**AI-guided, step-by-step code walkthroughs for VS Code.** Describe a problem; JustInTime uses Claude to decompose it into ordered steps, navigate you to each change, explain *what* it does (the pattern) and *why here* (this codebase), show a diff, and wait for your **Apply & Next** before landing anything.

Built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). Unlike autonomous "rewrite five files at once" agents, JustInTime keeps you in the loop and teaches the code as you change it.

## How it works

1. **Outline first.** Claude analyzes your codebase read-only and returns a lightweight, dependency-ordered plan — shown immediately.
2. **Lazy hydration.** Just before each step, JustInTime asks Claude for that step's concrete diff *against the current file state*, anchored by surrounding context rather than fragile line numbers. This is why it's immune to line-drift and to its own prior edits shifting later steps — the "just in time" in the name.
3. **Gated apply.** Each change is a gate: navigate → explain (twice) → diff → **Apply & Next** / **Skip** / **Pause**. Every applied change is snapshotted for a crash-proof **Revert All**.

## Requirements

- **The Claude Code CLI (`claude`) installed and authenticated.** JustInTime uses your existing `claude` login (or `ANTHROPIC_API_KEY`) and your installed CLI — it does not bundle a copy. Install from https://code.claude.com and run `claude` once to log in.

## Commands

- **JustInTime: Start Walkthrough** — describe a problem and begin
- **Pause / Resume / Skip Step / Revert All**
- **Set Anthropic API Key** — store a key in VS Code SecretStorage (only needed if you don't use a `claude` login)

## Settings

| Setting | Default | Description |
|---|---|---|
| `justintime.diffStyle` | `inline` | Diff display mode (`inline` / `split`) |
| `justintime.autoNavigate` | `true` | Open + scroll to the target file each step |
| `justintime.showPrerequisites` | `true` | Show the prerequisites section |
| `justintime.highlightColor` | `#FFF3CD` | Target range highlight color |
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
