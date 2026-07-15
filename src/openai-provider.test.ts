import { describe, it, expect } from 'vitest';
import { OpenAICompatibleProvider, type FetchFn } from './openai-provider';
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

describe('OpenAICompatibleProvider.answerQuestion', () => {
  it('returns the final non-tool message as the answer', async () => {
    const { provider } = makeProvider([
      // explore's first message has no tool calls, so its content is the answer
      { choices: [{ message: { content: 'The answer is 42.' } }] },
    ]);
    const answer = await provider.answerQuestion('why?', 'ctx', { workspaceRoot: '/repo' });
    expect(answer).toBe('The answer is 42.');
  });

  it('surfaces a non-OK HTTP response as an error', async () => {
    const badFetch = (async () => ({ ok: false, status: 401, async text() { return 'unauthorized'; }, async json() { return {}; } })) as unknown as FetchFn;
    const provider = new OpenAICompatibleProvider({ baseUrl: 'http://x/v1', apiKey: 'bad', model: 'm', label: 'Test', fetchFn: badFetch });
    await expect(provider.answerQuestion('q', 'c', { workspaceRoot: '/repo' })).rejects.toThrow(/401/);
  });
});
