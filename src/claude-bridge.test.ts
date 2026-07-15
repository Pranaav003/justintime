import { describe, it, expect } from 'vitest';
import { ClaudeAgentProvider, ProviderError, type QueryFn, type SdkMessage } from './claude-bridge';
import type { OutlineStep } from './types';

/** Build a fake query() that yields the given messages and records the args it was called with. */
function fakeQuery(messages: SdkMessage[]): { fn: QueryFn; calls: { prompt: string; options: Record<string, unknown> }[] } {
  const calls: { prompt: string; options: Record<string, unknown> }[] = [];
  const fn: QueryFn = (args) => {
    calls.push(args);
    return (async function* () {
      for (const m of messages) {
        yield m;
      }
    })();
  };
  return { fn, calls };
}

const validOutlinePayload = {
  problemSummary: 'Fix the race condition in checkout.',
  steps: [
    {
      stepNumber: 1,
      title: 'Guard the shared cart mutation',
      targetFiles: ['src/checkout.ts'],
      dependsOn: [],
      changeKind: 'edit',
      genericExplanation: 'A mutex serializes access to shared mutable state.',
      specificExplanation: 'cart.total is written from two async handlers.',
    },
  ],
};

const outlineStep: OutlineStep = {
  stepNumber: 1,
  title: 'Guard the shared cart mutation',
  targetFiles: ['src/checkout.ts'],
  dependsOn: [],
  changeKind: 'edit',
  genericExplanation: 'g',
  specificExplanation: 's',
};

const validHydratedPayload = {
  stepNumber: 1,
  primaryFile: 'src/checkout.ts',
  changeKind: 'edit',
  hunks: [{ contextBefore: 'function checkout() {', oldText: '  cart.total += p;', newText: '  await lock.run();', contextAfter: '}' }],
  navigation: { file: 'src/checkout.ts', startLine: 2, endLine: 2 },
};

const ctx = { workspaceRoot: '/repo' };

describe('produceOutline', () => {
  it('parses a successful result and attaches the session id', async () => {
    const { fn } = fakeQuery([
      { type: 'assistant', text: 'thinking...' },
      { type: 'result', subtype: 'success', structured_output: validOutlinePayload, session_id: 'sess-1' },
    ]);
    const provider = new ClaudeAgentProvider(fn);
    const outline = await provider.produceOutline('fix checkout race', ctx);
    expect(outline.sessionId).toBe('sess-1');
    expect(outline.steps).toHaveLength(1);
    expect(outline.problemSummary).toContain('race');
  });

  it('sends read-only tools, dontAsk, structured output, cwd and preset system prompt', async () => {
    const { fn, calls } = fakeQuery([
      { type: 'result', subtype: 'success', structured_output: validOutlinePayload, session_id: 'sess-1' },
    ]);
    await new ClaudeAgentProvider(fn).produceOutline('p', ctx);
    const opts = calls[0]!.options;
    expect(opts.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(['Write', 'Edit', 'Bash']));
    expect(opts.permissionMode).toBe('dontAsk');
    expect(opts.cwd).toBe('/repo');
    expect((opts.outputFormat as { type: string }).type).toBe('json_schema');
    expect((opts.systemPrompt as { preset: string }).preset).toBe('claude_code');
  });

  it('throws max_retries when the model never satisfied the schema', async () => {
    const { fn } = fakeQuery([{ type: 'result', subtype: 'error_max_structured_output_retries' }]);
    await expect(new ClaudeAgentProvider(fn).produceOutline('p', ctx)).rejects.toMatchObject({ code: 'max_retries' });
  });

  it('throws no_result when the stream ends without a result message', async () => {
    const { fn } = fakeQuery([{ type: 'assistant', text: 'oops' }]);
    await expect(new ClaudeAgentProvider(fn).produceOutline('p', ctx)).rejects.toMatchObject({ code: 'no_result' });
  });

  it('throws no_session when the result has no session id', async () => {
    const { fn } = fakeQuery([{ type: 'result', subtype: 'success', structured_output: validOutlinePayload }]);
    await expect(new ClaudeAgentProvider(fn).produceOutline('p', ctx)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('hydrateStep', () => {
  it('resumes the session, requests structured output, and returns a HydratedStep with empty hazards', async () => {
    const { fn, calls } = fakeQuery([
      { type: 'result', subtype: 'success', structured_output: validHydratedPayload, session_id: 'sess-1' },
    ]);
    const provider = new ClaudeAgentProvider(fn);
    const step = await provider.hydrateStep(outlineStep, { 'src/checkout.ts': 'function checkout() {\n  cart.total += p;\n}' }, { sessionId: 'sess-1', workspaceRoot: '/repo' });
    expect(step.hazards).toEqual([]);
    expect(step.hunks).toHaveLength(1);
    const opts = calls[0]!.options;
    expect(opts.resume).toBeUndefined(); // stateless hydration — no session resume
    expect(opts.cwd).toBe('/repo');
    expect((opts.outputFormat as { type: string }).type).toBe('json_schema');
  });

  it('includes the current file content in the prompt', async () => {
    const { fn, calls } = fakeQuery([
      { type: 'result', subtype: 'success', structured_output: validHydratedPayload, session_id: 'sess-1' },
    ]);
    await new ClaudeAgentProvider(fn).hydrateStep(outlineStep, { 'src/checkout.ts': 'UNIQUE_MARKER_XYZ' }, { sessionId: 'sess-1', workspaceRoot: '/repo' });
    expect(calls[0]!.prompt).toContain('UNIQUE_MARKER_XYZ');
    expect(calls[0]!.prompt).toContain('src/checkout.ts');
  });

  it('throws invalid_output when the payload violates the schema (edit with no hunks)', async () => {
    const bad = { ...validHydratedPayload, hunks: [] };
    const { fn } = fakeQuery([{ type: 'result', subtype: 'success', structured_output: bad, session_id: 'sess-1' }]);
    await expect(
      new ClaudeAgentProvider(fn).hydrateStep(outlineStep, {}, { sessionId: 'sess-1', workspaceRoot: '/repo' }),
    ).rejects.toMatchObject({ code: 'invalid_output' });
  });
});

describe('progress, options, and error codes', () => {
  it('reports a tool_use_summary message via onProgress', async () => {
    const { fn } = fakeQuery([
      { type: 'tool_use_summary', summary: 'Read src/a.ts' },
      { type: 'result', subtype: 'success', structured_output: validOutlinePayload, session_id: 's' },
    ]);
    const progress: string[] = [];
    await new ClaudeAgentProvider(fn).produceOutline('p', { workspaceRoot: '/r', onProgress: (t) => progress.push(t) });
    expect(progress).toContain('Read src/a.ts');
  });

  it('describes assistant tool_use blocks (Read/Grep/Glob/unknown)', async () => {
    const { fn } = fakeQuery([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
            { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } },
            { type: 'tool_use', name: 'Mystery', input: {} },
          ],
        },
      },
      { type: 'result', subtype: 'success', structured_output: validOutlinePayload, session_id: 's' },
    ]);
    const progress: string[] = [];
    await new ClaudeAgentProvider(fn).produceOutline('p', { workspaceRoot: '/r', onProgress: (t) => progress.push(t) });
    expect(progress).toContain('Reading src/a.ts');
    expect(progress.some((p) => p.includes('Searching'))).toBe(true);
    expect(progress.some((p) => p.includes('Scanning'))).toBe(true);
    expect(progress.some((p) => p.startsWith('Mystery'))).toBe(true);
  });

  it('throws no_output when a success result has no structured_output', async () => {
    const { fn } = fakeQuery([{ type: 'result', subtype: 'success', session_id: 's' }]);
    await expect(new ClaudeAgentProvider(fn).produceOutline('p', ctx)).rejects.toMatchObject({ code: 'no_output' });
  });

  it('throws sdk_error for an unknown non-success subtype', async () => {
    const { fn } = fakeQuery([{ type: 'result', subtype: 'error_during_execution' }]);
    await expect(new ClaudeAgentProvider(fn).produceOutline('p', ctx)).rejects.toMatchObject({ code: 'sdk_error' });
  });

  it('wraps a thrown query error as sdk_error', async () => {
    const fn: QueryFn = () =>
      (async function* (): AsyncIterable<SdkMessage> {
        throw new Error('network down');
      })();
    await expect(new ClaudeAgentProvider(fn).produceOutline('p', ctx)).rejects.toMatchObject({ code: 'sdk_error' });
  });

  it('forwards model + maxTurns and bridges the abort signal into options', async () => {
    const { fn, calls } = fakeQuery([
      { type: 'result', subtype: 'success', structured_output: validOutlinePayload, session_id: 's' },
    ]);
    const ac = new AbortController();
    await new ClaudeAgentProvider(fn, { model: 'claude-x', maxTurns: 42 }).produceOutline('p', {
      workspaceRoot: '/r',
      signal: ac.signal,
    });
    const opts = calls[0]!.options;
    expect(opts.model).toBe('claude-x');
    expect(opts.maxTurns).toBe(42);
    expect(opts.abortController).toBeInstanceOf(AbortController);
  });

  it('answerQuestion returns result.result text, and empty string when absent', async () => {
    const { fn } = fakeQuery([{ type: 'result', subtype: 'success', result: 'the answer', session_id: 's' }]);
    expect(await new ClaudeAgentProvider(fn).answerQuestion('q', 'c', { workspaceRoot: '/r' })).toBe('the answer');
    const { fn: fn2 } = fakeQuery([{ type: 'result', subtype: 'success', session_id: 's' }]);
    expect(await new ClaudeAgentProvider(fn2).answerQuestion('q', 'c', { workspaceRoot: '/r' })).toBe('');
  });
});
