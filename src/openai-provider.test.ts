import { describe, it, expect } from 'vitest';
import { OpenAICompatibleProvider, resolvePath, extractJson, detectTextToolCall, type FetchFn } from './openai-provider';
import type { OutlineStep } from './types';

/** A scripted fake fetch: returns queued chat-completion responses in order. */
function fakeFetch(responses: unknown[]): { fn: FetchFn; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const queue = [...responses];
  const fn = (async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ? JSON.parse(init.body) : undefined);
    const payload = queue.shift() ?? { choices: [{ message: { content: '' } }] };
    return {
      ok: true,
      status: 200,
      async json() {
        return payload;
      },
      async text() {
        return '';
      },
    };
  }) as unknown as FetchFn;
  return { fn, bodies };
}

const validOutlinePayload = {
  problemSummary: 'Fix it.',
  steps: [
    {
      stepNumber: 1,
      title: 'Do the thing',
      targetFiles: ['a.ts'],
      dependsOn: [],
      changeKind: 'edit',
      genericExplanation: 'g',
      specificExplanation: 's',
    },
  ],
};

const outlineStep: OutlineStep = {
  stepNumber: 1,
  title: 'Do the thing',
  targetFiles: ['a.ts'],
  dependsOn: [],
  changeKind: 'edit',
  genericExplanation: 'g',
  specificExplanation: 's',
};

function makeProvider(responses: unknown[]) {
  const { fn, bodies } = fakeFetch(responses);
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://x/v1',
    apiKey: 'k',
    model: 'gpt-4o',
    label: 'Test',
    fetchFn: fn,
  });
  return { provider, bodies };
}

describe('resolvePath', () => {
  const map = ['src/stats.ts', 'src/utils/format.ts', 'README.md', 'src/a.ts', 'test/a.ts'];
  it('returns the path as-is when there is no repo map', () => {
    expect(resolvePath('anything.ts', undefined)).toBe('anything.ts');
    expect(resolvePath('anything.ts', [])).toBe('anything.ts');
  });
  it('returns an exact match', () => {
    expect(resolvePath('src/stats.ts', map)).toBe('src/stats.ts');
  });
  it('resolves a unique suffix match', () => {
    expect(resolvePath('stats.ts', map)).toBe('src/stats.ts');
    expect(resolvePath('utils/format.ts', map)).toBe('src/utils/format.ts');
  });
  it('resolves a unique basename match', () => {
    expect(resolvePath('format.ts', map)).toBe('src/utils/format.ts');
  });
  it('returns undefined for an ambiguous basename (a.ts appears twice)', () => {
    expect(resolvePath('a.ts', map)).toBeUndefined();
  });
});

describe('extractJson', () => {
  it('unwraps a fenced json block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('strips leading/trailing prose via brace scanning', () => {
    expect(extractJson('Here you go: {"a":2} — done')).toEqual({ a: 2 });
  });
  it('parses a bare object', () => {
    expect(extractJson('{"a":3}')).toEqual({ a: 3 });
  });
});

describe('OpenAICompatibleProvider.produceOutline', () => {
  it('runs the read_files tool loop then returns a parsed outline', async () => {
    const read: string[] = [];
    const { provider, bodies } = makeProvider([
      // round 1: model asks to read a file
      { choices: [{ message: { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_files', arguments: '{"paths":["a.ts"]}' } }] } }] },
      // round 2: model is done exploring
      { choices: [{ message: { content: 'ready' } }] },
      // final: the JSON outline
      { choices: [{ message: { content: JSON.stringify(validOutlinePayload) } }] },
    ]);
    const outline = await provider.produceOutline('fix it', {
      workspaceRoot: '/repo',
      mode: 'solve',
      repoMap: ['a.ts'],
      readFile: async (p) => {
        read.push(p);
        return `content of ${p}`;
      },
    });
    expect(read).toEqual(['a.ts']);
    expect(outline.mode).toBe('solve');
    expect(outline.steps).toHaveLength(1);
    expect(outline.sessionId).toContain('openai');
    // the final call requested a json_object response
    expect((bodies[2] as { response_format?: { type: string } }).response_format?.type).toBe('json_object');
  });

  it('serves search_code before producing the outline', async () => {
    const searched: string[] = [];
    const { fn } = fakeFetch([
      { choices: [{ message: { content: '', tool_calls: [{ id: 's1', type: 'function', function: { name: 'search_code', arguments: '{"query":"except|raise"}' } }] } }] },
      { choices: [{ message: { content: 'found it' } }] },
      { choices: [{ message: { content: JSON.stringify(validOutlinePayload) } }] },
    ]);
    const provider = new OpenAICompatibleProvider({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', label: 'Test', fetchFn: fn });
    const outline = await provider.produceOutline('how are errors handled', {
      workspaceRoot: '/repo',
      mode: 'explain',
      searchCode: async (q) => {
        searched.push(q);
        return 'a.ts:5: raise ValueError("x")';
      },
    });
    expect(searched).toEqual(['except|raise']);
    expect(outline.steps).toHaveLength(1);
  });

  it('retries once when the first JSON is invalid', async () => {
    const { provider } = makeProvider([
      { choices: [{ message: { content: 'ready' } }] }, // explore: no tool calls
      { choices: [{ message: { content: 'not json' } }] }, // bad json
      { choices: [{ message: { content: JSON.stringify(validOutlinePayload) } }] }, // corrected
    ]);
    const outline = await provider.produceOutline('fix it', { workspaceRoot: '/repo', mode: 'solve' });
    expect(outline.steps).toHaveLength(1);
  });
});

describe('OpenAICompatibleProvider.hydrateStep', () => {
  it('returns a HydratedStep with empty hazards', async () => {
    const payload = {
      stepNumber: 1,
      primaryFile: 'a.ts',
      changeKind: 'edit',
      hunks: [{ contextBefore: 'a', oldText: 'b', newText: 'c', contextAfter: 'd' }],
      navigation: { file: 'a.ts', startLine: 1, endLine: 1 },
    };
    const { provider } = makeProvider([{ choices: [{ message: { content: JSON.stringify(payload) } }] }]);
    const step = await provider.hydrateStep(outlineStep, { 'a.ts': 'x' }, { sessionId: 's', workspaceRoot: '/repo' });
    expect(step.hazards).toEqual([]);
    expect(step.hunks).toHaveLength(1);
  });
});

describe('OpenAICompatibleProvider tool loop + JSON', () => {
  const toolCall = (name: string, args: string) => ({
    choices: [{ message: { content: '', tool_calls: [{ id: 't', type: 'function', function: { name, arguments: args } }] } }],
  });
  const done = { choices: [{ message: { content: 'done' } }] };
  const jsonOut = { choices: [{ message: { content: JSON.stringify(validOutlinePayload) } }] };

  it('throws a friendly error when structured output fails twice', async () => {
    const { provider } = makeProvider([done, { choices: [{ message: { content: 'not json' } }] }, { choices: [{ message: { content: 'still not json' } }] }]);
    await expect(provider.produceOutline('p', { workspaceRoot: '/r', mode: 'solve' })).rejects.toThrow(/didn't return a valid plan/);
  });

  it('exits the tool loop after MAX_TOOL_ROUNDS and still produces output', async () => {
    const t = toolCall('search_code', '{"query":"x"}');
    const { provider } = makeProvider([t, t, t, t, t, jsonOut]);
    const outline = await provider.produceOutline('p', { workspaceRoot: '/r', mode: 'solve', searchCode: async () => 'x:1: y' });
    expect(outline.steps).toHaveLength(1);
  });

  it('handles an unknown tool call without crashing', async () => {
    const { provider } = makeProvider([toolCall('mystery', '{}'), done, jsonOut]);
    const outline = await provider.produceOutline('p', { workspaceRoot: '/r', mode: 'solve' });
    expect(outline.steps).toHaveLength(1);
  });

  it('read_files resolves a fuzzy path to the real file', async () => {
    const read: string[] = [];
    const { provider } = makeProvider([toolCall('read_files', '{"paths":["stats.ts"]}'), done, jsonOut]);
    await provider.produceOutline('p', {
      workspaceRoot: '/r',
      mode: 'solve',
      repoMap: ['src/stats.ts'],
      readFile: async (p) => {
        read.push(p);
        return 'content';
      },
    });
    expect(read).toEqual(['src/stats.ts']);
  });

  it('search_code with an empty query does not call searchCode', async () => {
    let called = 0;
    const { provider } = makeProvider([toolCall('search_code', '{"query":""}'), done, jsonOut]);
    await provider.produceOutline('p', {
      workspaceRoot: '/r',
      mode: 'solve',
      searchCode: async () => {
        called++;
        return 'x';
      },
    });
    expect(called).toBe(0);
  });

  it('hydrateStep defaults primaryFile from the outline step', async () => {
    const payload = {
      changeKind: 'edit',
      hunks: [{ contextBefore: 'a', oldText: 'b', newText: 'c', contextAfter: 'd' }],
      navigation: { file: 'x', startLine: 1, endLine: 1 },
    };
    const { provider } = makeProvider([{ choices: [{ message: { content: JSON.stringify(payload) } }] }]);
    const step = await provider.hydrateStep(outlineStep, { 'a.ts': 'x' }, { sessionId: 's', workspaceRoot: '/r' });
    expect(step.primaryFile).toBe('a.ts');
  });
});

describe('detectTextToolCall', () => {
  it('recognizes a fenced JSON tool call for a known tool', () => {
    const call = detectTextToolCall('```json\n{"name":"search_code","arguments":{"query":"divide"}}\n```');
    expect(call?.function.name).toBe('search_code');
    expect(JSON.parse(call!.function.arguments)).toEqual({ query: 'divide' });
  });
  it('serializes object arguments to a JSON string and accepts "parameters"', () => {
    const call = detectTextToolCall('{"name":"read_files","parameters":{"paths":["a.ts"]}}');
    expect(call?.function.name).toBe('read_files');
    expect(JSON.parse(call!.function.arguments)).toEqual({ paths: ['a.ts'] });
  });
  it('ignores prose and JSON for unknown tools', () => {
    expect(detectTextToolCall('just a plain english answer')).toBeUndefined();
    expect(detectTextToolCall('{"name":"launch_missiles","arguments":{}}')).toBeUndefined();
    expect(detectTextToolCall('{"summary":"no name field"}')).toBeUndefined();
  });
});

describe('OpenAICompatibleProvider.answerQuestion', () => {
  it('returns the final non-tool message as the answer', async () => {
    const { provider } = makeProvider([
      // explore's first message has no tool calls, so its content is the answer
      { choices: [{ message: { content: 'The answer is 42.' } }] },
    ]);
    const answer = await provider.answerQuestion('why?', 'ctx', { workspaceRoot: '/repo' });
    expect(answer).toBe('The answer is 42.');
  });

  it('executes a tool call emitted as plain-text JSON, then returns prose (regression)', async () => {
    const searched: string[] = [];
    const { provider } = makeProvider([
      // weak-model shape: tool call as fenced JSON in content, no tool_calls array
      { choices: [{ message: { content: '```json\n{"name":"search_code","arguments":{"query":"divide"}}\n```' } }] },
      { choices: [{ message: { content: 'Dividing by zero yields NaN because JS uses IEEE-754 floats.' } }] },
    ]);
    const answer = await provider.answerQuestion('why NaN?', 'ctx', {
      workspaceRoot: '/r',
      searchCode: async (q) => {
        searched.push(q);
        return 'stats.ts:8: return sum / nums.length;';
      },
    });
    expect(searched).toEqual(['divide']); // the text tool call was actually executed
    expect(answer).toContain('IEEE-754'); // and the grounded prose is returned, not the JSON
  });

  it('forces a tools-off prose answer when the loop keeps emitting tool-call JSON (regression)', async () => {
    const toolText = { choices: [{ message: { content: '{"name":"search_code","arguments":{"query":"x"}}' } }] };
    // 5 rounds all emit the same text tool call (search unavailable), then a final tools-off call.
    const { provider, bodies } = makeProvider([
      toolText,
      toolText,
      toolText,
      toolText,
      toolText,
      { choices: [{ message: { content: 'Plain prose answer grounded in what was found.' } }] },
    ]);
    const answer = await provider.answerQuestion('q', 'ctx', { workspaceRoot: '/r' }); // no searchCode
    expect(answer).toBe('Plain prose answer grounded in what was found.');
    // the final fallback call must NOT offer tools (forces prose, not another tool call)
    expect((bodies.at(-1) as { tools?: unknown[] }).tools).toBeUndefined();
  });

  it('surfaces a non-OK HTTP response as an error', async () => {
    const badFetch = (async () => ({ ok: false, status: 401, async text() { return 'unauthorized'; }, async json() { return {}; } })) as unknown as FetchFn;
    const provider = new OpenAICompatibleProvider({ baseUrl: 'http://x/v1', apiKey: 'bad', model: 'm', label: 'Test', fetchFn: badFetch });
    await expect(provider.answerQuestion('q', 'c', { workspaceRoot: '/repo' })).rejects.toThrow(/401/);
  });
});
