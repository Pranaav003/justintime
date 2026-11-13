import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHunks } from './anchor';
import { CodexCliProvider } from './codex-provider';
import type { CodexCompletionRequest, CodexCompletionRunner } from './codex-cli';
import type { OutlineStep } from './types';

const step: OutlineStep = { stepNumber: 1, title: 'Explain f', targetFiles: ['src/a.ts'], dependsOn: [], changeKind: 'edit', genericExplanation: 'A function', specificExplanation: 'f returns 1' };
const outline = { problemSummary: 'f returns 1', steps: [step] };
const envelope = (content: unknown, tool_calls: unknown[] = []) => JSON.stringify({ content, tool_calls });
const final = (value: unknown = outline) => envelope(JSON.stringify(value));
const read = (paths = ['src/a.ts']) => envelope('', [{ name: 'read_files', paths, query: '' }]);
const search = () => envelope('', [{ name: 'search_code', paths: [], query: 'f' }]);
const ctx = () => ({ workspaceRoot: '/private/work/project', repoMap: ['src/a.ts'], readFile: vi.fn(async () => 'export function f() { return 1; }') });
function setup(packets: (string | Error)[]) {
  const requests: CodexCompletionRequest[] = [];
  const runner: CodexCompletionRunner = vi.fn(async (request) => {
    requests.push(request);
    const packet = packets.shift();
    if (packet instanceof Error) throw packet;
    if (packet === undefined) throw new Error('unexpected extra completion');
    return packet;
  });
  return { provider: new CodexCliProvider({}, runner), requests, runner };
}

describe('CodexCliProvider', () => {
  it.each(['solve', 'explain'] as const)('grounds %s and reuses a valid terminal without an extra completion', async (mode) => {
    const payload = mode === 'explain' ? { ...outline, steps: [{ ...step, focus: { file: 'src/a.ts', startLine: 1, endLine: 1, anchor: 'export function f() { return 1; }' } }] } : outline;
    const { provider, requests } = setup([read(), final(payload)]);
    const context = ctx();
    const result = await provider.produceOutline('how does f work?', { ...context, mode });
    expect(result).toMatchObject({ ...payload, mode, sessionId: 'codex-gpt-6-sol' });
    expect(requests).toHaveLength(2);
    expect(requests[1].prompt).toContain('export function f() { return 1; }');
    expect(requests[0].model).toBe('gpt-6-sol');
    expect(requests[0].prompt).not.toContain(context.workspaceRoot);
    if (mode === 'explain') expect(requests[0].prompt).toContain('focus.anchor');
  });

  it.each([
    { model: undefined, want: 'gpt-6-sol' },
    { model: '', want: 'gpt-6-sol' },
    { model: ' \t\n ', want: 'gpt-6-sol' },
    { model: 'gpt-6-sol', want: 'gpt-6-sol' },
    { model: 'gpt-6-luna', want: 'gpt-6-luna' },
    { model: ' chosen-model ', want: ' chosen-model ' },
  ])('resolves Codex model $model to $want on actual completion requests', async ({ model, want }) => {
    const packets = [read(), final()];
    const requests: CodexCompletionRequest[] = [];
    const provider = new CodexCliProvider({ model }, async request => {
      requests.push(request);
      return packets.shift()!;
    });
    expect((await provider.produceOutline('explain f', ctx())).sessionId).toBe(`codex-${want}`);
    expect(requests.map(request => request.model)).toEqual([want, want]);
  });

  it('emits identical default and explicit Sol requests for outline, chat and hydration', async () => {
    const capture = async (model?: string) => {
      const packets = [read(), final(), read(), envelope('f returns 1.'), final({ changeKind: 'delete' })];
      const requests: CodexCompletionRequest[] = [];
      const provider = new CodexCliProvider({ model }, async request => {
        requests.push(request);
        return packets.shift()!;
      });
      await provider.produceOutline('explain f', ctx());
      await provider.answerQuestion('what does f return?', '', ctx());
      await provider.hydrateStep(step, { 'src/a.ts': 'export function f() { return 1; }' }, { sessionId: 'same-session', workspaceRoot: '/private/work/project' });
      expect(packets).toEqual([]);
      return requests;
    };
    expect(await capture()).toEqual(await capture('gpt-6-sol'));
  });

  it('uses a strict CLI schema including required typed arguments at every object level', async () => {
    const { provider, requests } = setup([read(), final()]);
    await provider.produceOutline('explain', ctx());
    const visit = (schema: Record<string, any>) => {
      if (schema.type === 'object') {
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required.slice().sort()).toEqual(Object.keys(schema.properties).sort());
        Object.values(schema.properties).forEach((value) => visit(value as Record<string, any>));
      }
      if (schema.items) visit(schema.items);
    };
    visit(requests[0].schema);
    expect((requests[0].schema.properties as any).tool_calls.items.properties).toMatchObject({ name: { enum: ['read_files', 'search_code'] }, paths: { type: 'array' }, query: { type: 'string' } });
  });

  it.each(['outline', 'chat'] as const)('requires a JSON tool request before %s evidence and permits a final afterward', async (method) => {
    const terminal = method === 'outline' ? final() : envelope('f returns 1.');
    const { provider, requests } = setup([envelope('Host tools are unavailable here.'), read(), terminal]);
    const context = ctx();
    await (method === 'outline' ? provider.produceOutline('explain', context) : provider.answerQuestion('why?', '', context));
    expect(context.readFile).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(3);
    for (const request of requests.slice(0, 2)) {
      expect((request.schema.properties as any).tool_calls.minItems).toBe(1);
    }
    expect((requests[2].schema.properties as any).tool_calls.minItems).toBeUndefined();
  });

  it('rejects a second tool-free response before evidence without callbacks or a third completion', async () => {
    const { provider, requests } = setup([envelope('Host tools are unavailable here.'), envelope('No tools available.'), read()]);
    const context = ctx();
    await expect(provider.answerQuestion('why?', '', context)).rejects.toThrow(/required schema/);
    expect(context.readFile).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
  });

  it('keeps tools required after unknown reads and empty searches until a read supplies evidence', async () => {
    const { provider, requests } = setup([read(['missing.ts']), search(), read(), final()]);
    const context = { ...ctx(), searchCode: vi.fn(async () => '(no matches for f)') };
    await provider.produceOutline('explain', context);
    expect(context.readFile).toHaveBeenCalledTimes(1);
    expect(context.searchCode).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(4);
    for (const request of requests.slice(0, 3)) {
      expect((request.schema.properties as any).tool_calls.minItems).toBe(1);
    }
    expect((requests[3].schema.properties as any).tool_calls.minItems).toBeUndefined();
  });

  it.each(['outline', 'chat', 'hydrate'] as const)('corrects one invalid terminal in %s and stops after a second invalid response', async (method) => {
    const invoke = (provider: CodexCliProvider) => method === 'outline' ? provider.produceOutline('explain', ctx())
      : method === 'chat' ? provider.answerQuestion('why', '', ctx())
        : provider.hydrateStep(step, { 'src/a.ts': 'dirty content' }, { sessionId: 'old', workspaceRoot: '/repo' });
    const prefix = method === 'hydrate' ? [] : [read()];
    const good = method === 'chat' ? envelope('f returns 1') : method === 'hydrate' ? final({ changeKind: 'delete' }) : final();
    const okay = setup([...prefix, envelope(method === 'chat' ? '' : 'broken'), good]);
    await expect(invoke(okay.provider)).resolves.toBeDefined();
    expect(okay.requests).toHaveLength(prefix.length + 2);
    expect(okay.requests.at(-1)!.prompt).toContain('required schema');
    const failed = setup([...prefix, envelope(method === 'chat' ? '' : 'broken'), envelope(method === 'chat' ? '' : 'broken'), good]);
    // Plain prose is the valid chat contract; use an empty response for its failure.
    await expect(invoke(failed.provider)).rejects.toThrow(/valid|schema|format/i);
    expect(failed.requests).toHaveLength(prefix.length + 2);
  });

  it('answers chat from callback evidence without another completion', async () => {
    const { provider, requests } = setup([read(), envelope('`f` returns 1.')]);
    await expect(provider.answerQuestion('why?', '', ctx())).resolves.toBe('`f` returns 1.');
    expect(requests).toHaveLength(2);
  });

  it('requires read evidence when reading is available rather than accepting search results', async () => {
    const { provider, requests } = setup([search(), final(), read(), final()]);
    const result = await provider.produceOutline('explain', { ...ctx(), searchCode: async () => 'src/a.ts:1:f' });
    expect(result.problemSummary).toBe(outline.problemSummary);
    expect(requests).toHaveLength(4);
    expect((requests[2].schema.properties as any).tool_calls.minItems).toBe(1);
  });

  it('supports search evidence when reading is unavailable', async () => {
    const { provider } = setup([search(), envelope('Search found f in src/a.ts.')]);
    await expect(provider.answerQuestion('where?', '', { workspaceRoot: '/repo', searchCode: async () => 'src/a.ts:1:f' })).resolves.toContain('src/a.ts');
  });

  it('does not accept unknown files or empty searches as evidence across the existing tool budget', async () => {
    const { provider, requests } = setup([read(['missing.ts']), search(), read(['missing.ts']), search(), search()]);
    const context = ctx();
    await expect(provider.produceOutline('explain', { ...context, searchCode: async () => '(no matches for f)' })).rejects.toThrow(/required workspace code evidence/);
    expect(context.readFile).not.toHaveBeenCalled();
    expect(requests).toHaveLength(5);
  });

  it.each([
    { content: '', tool_calls: [{ name: 'read_files', paths: 'src/a.ts', query: '' }] },
    { content: '', tool_calls: [{ name: 'read_files', paths: ['src/a.ts'] }] },
    { content: '', tool_calls: [{ name: 'shell', paths: [], query: '' }] },
    { content: '', tool_calls: [], extra: true },
    { content: null, tool_calls: [] },
  ])('corrects malformed envelopes without invoking host tools: %j', async (invalid) => {
    const { provider, requests } = setup([JSON.stringify(invalid), read(), final()]);
    const context = ctx();
    await provider.produceOutline('explain', context);
    expect(context.readFile).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(3);
  });

  it('corrects invalid outer JSON and retains only host-serialized tool arguments', async () => {
    const path = 'src/quoted\"file.ts';
    const { provider, requests } = setup(['{invalid', read([path]), final()]);
    const readFile = vi.fn(async () => 'source');
    await provider.produceOutline('explain', { workspaceRoot: '/repo', repoMap: [path], readFile });
    expect(readFile).toHaveBeenCalledWith(path);
    const transcript = JSON.parse(requests[2].prompt.slice(requests[2].prompt.indexOf('[{')));
    const call = transcript.find((message: any) => message.tool_calls)?.tool_calls[0];
    expect(call.type).toBe('function');
    expect(JSON.parse(call.function.arguments)).toEqual({ paths: [path] });
  });

  it('passes maxSteps through the shared outline prompt', async () => {
    const runner = vi.fn().mockResolvedValueOnce(read()).mockResolvedValueOnce(final());
    const provider = new CodexCliProvider({ maxSteps: 2 }, runner);
    await provider.produceOutline('explain', ctx());
    expect(runner.mock.calls[0][0].prompt).toContain('at most 2 steps');
  });

  it('shares the formatting retry budget between envelope and inner domain errors', async () => {
    const { provider, requests } = setup(['{}', read(), envelope('{}'), final()]);
    await expect(provider.produceOutline('explain', ctx())).rejects.toThrow(/valid|schema|format/i);
    expect(requests).toHaveLength(3);
  });

  it('fails before inference when outline or chat has no workspace callbacks', async () => {
    const { provider, runner } = setup([]);
    await expect(provider.produceOutline('explain', { workspaceRoot: '/repo' })).rejects.toThrow(/callback|evidence/i);
    await expect(provider.answerQuestion('why?', '', { workspaceRoot: '/repo' })).rejects.toThrow(/callback|evidence/i);
    expect(runner).not.toHaveBeenCalled();
  });

  it('preserves dirty hydration buffers exactly and has no file tools', async () => {
    const dirty = '\tunsaved \r\n  value\n';
    const payload = { changeKind: 'edit', hunks: [{ contextBefore: '', oldText: dirty, newText: 'new', contextAfter: '' }] };
    const { provider, requests } = setup([final(payload)]);
    const result = await provider.hydrateStep(step, { 'src/a.ts': dirty }, { workspaceRoot: '/repo', sessionId: 'old' });
    expect(result.hunks![0].oldText).toBe(dirty);
    expect(JSON.parse(requests[0].prompt.slice(requests[0].prompt.indexOf('[{')))[1].content).toContain(dirty);
    expect((requests[0].schema.properties as any).tool_calls.maxItems).toBe(0);
    expect((requests[0].schema.properties as any).tool_calls.minItems).toBeUndefined();
    expect(result.hazards).toEqual([]);
  });

  it('corrects a schema-valid hunk whose context skips intervening lines', async () => {
    const current = 'import { helper } from "./helper";\n\nexport function f() {\n  return 1;\n}\n';
    const bad = { changeKind: 'edit', hunks: [{ contextBefore: 'import { helper } from "./helper";', oldText: '  return 1;', newText: '  return 2;', contextAfter: '}' }] };
    const good = { changeKind: 'edit', hunks: [{ ...bad.hunks[0], contextBefore: 'export function f() {' }] };
    expect(applyHunks(current, bad.hunks)).toMatchObject({ status: 'error', reason: 'not_found' });
    const { provider, requests } = setup([final(bad), final(good)]);
    const result = await provider.hydrateStep(step, { 'src/a.ts': current }, { workspaceRoot: '/repo', sessionId: 'old' });
    expect(result.hunks).toEqual(good.hunks);
    expect(applyHunks(current, result.hunks!)).toMatchObject({ status: 'ok', text: current.replace('return 1', 'return 2') });
    expect(requests).toHaveLength(2);
    expect(requests[1].prompt).toContain('contiguous');
    expect(requests[1].prompt).toContain('no skipped lines');
  });

  it('rejects a second unanchorable hydration proposal without a third completion', async () => {
    const bad = { changeKind: 'edit', hunks: [{ contextBefore: 'import x;', oldText: '  return 1;', newText: '  return 2;', contextAfter: '}' }] };
    const { provider, requests } = setup([final(bad), final(bad), final({ changeKind: 'delete' })]);
    await expect(provider.hydrateStep(step, { 'src/a.ts': 'import x;\nfunction f() {\n  return 1;\n}\n' }, { workspaceRoot: '/repo', sessionId: 'old' })).rejects.toThrow(/valid|schema|format/i);
    expect(requests).toHaveLength(2);
  });

  it('validates against dirty supplied content while leaving stale disk contents untouched', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'jit-codex-dirty-'));
    const file = join(workspaceRoot, 'a.ts');
    const stale = 'export const value = 1;\n';
    const dirty = '\texport const value = 7;  \r\n';
    await writeFile(file, stale);
    try {
      const proposal = (oldText: string) => ({ primaryFile: 'a.ts', changeKind: 'edit', hunks: [{ contextBefore: '', oldText, newText: 'export const value = 8;', contextAfter: '' }] });
      const { provider, requests } = setup([final(proposal(stale)), final(proposal(dirty))]);
      const current = { 'a.ts': dirty };
      const result = await provider.hydrateStep({ ...step, targetFiles: ['a.ts'] }, current, { workspaceRoot, sessionId: 'old' });
      expect(requests).toHaveLength(2);
      expect(result.hunks![0].oldText).toBe(dirty);
      expect(current['a.ts']).toBe(dirty);
      expect(await readFile(file, 'utf8')).toBe(stale);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects edit proposals when their primary file has no supplied current content', async () => {
    const edit = { changeKind: 'edit', hunks: [{ contextBefore: '', oldText: 'source', newText: 'new', contextAfter: '' }] };
    const { provider, requests } = setup([final(edit), final(edit)]);
    await expect(provider.hydrateStep(step, {}, { workspaceRoot: '/repo', sessionId: 'old' })).rejects.toThrow(/valid|schema|format/i);
    expect(requests).toHaveLength(2);
  });

  it('rejects hydration tool calls and retries only once', async () => {
    const { provider, requests } = setup([read(), read(), final({ changeKind: 'delete' })]);
    await expect(provider.hydrateStep(step, {}, { workspaceRoot: '/repo', sessionId: 'old' })).rejects.toThrow(/valid|schema|format/i);
    expect(requests).toHaveLength(2);
  });

  it('forwards options and cancellation and propagates runner and callback failures without retry', async () => {
    const failure = new Error('runner failed');
    const { provider, requests } = setup([failure]);
    await expect(provider.produceOutline('explain', ctx())).rejects.toBe(failure);
    expect(requests).toHaveLength(1);
    const callbackError = new Error('read failed');
    const call = setup([read()]);
    await expect(call.provider.produceOutline('explain', { ...ctx(), readFile: async () => { throw callbackError; } })).rejects.toBe(callbackError);
    expect(call.requests).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    const aborted = setup([]);
    await expect(aborted.provider.produceOutline('explain', { ...ctx(), signal: controller.signal })).rejects.toThrow();
    expect(aborted.runner).not.toHaveBeenCalled();
    const log = vi.fn();
    const runner = vi.fn(async () => final({ changeKind: 'delete' }));
    await new CodexCliProvider({ model: 'chosen', executable: '/opt/codex', timeoutMs: 12, workspaceRoots: ['/repo', '/other'], log }, runner).hydrateStep(step, {}, { workspaceRoot: '/repo', sessionId: 'old' });
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ model: 'chosen', executable: '/opt/codex', timeoutMs: 12, workspaceRoots: ['/repo', '/other'], log }));
  });

  it('fails on empty search-only evidence after the existing exploration budget', async () => {
    const { provider, requests } = setup([search(), search(), search(), search(), search()]);
    await expect(provider.answerQuestion('where?', '', { workspaceRoot: '/repo', searchCode: async () => '(no matches for f)' })).rejects.toThrow(/required workspace code evidence/);
    expect(requests).toHaveLength(5);
  });

  it('propagates search callback errors without a formatting retry', async () => {
    const failure = new Error('search failed');
    const { provider, requests } = setup([search()]);
    await expect(provider.answerQuestion('where?', '', { workspaceRoot: '/repo', searchCode: async () => { throw failure; } })).rejects.toBe(failure);
    expect(requests).toHaveLength(1);
  });

  it('rechecks cancellation after the completion runner resolves', async () => {
    const controller = new AbortController();
    const readFile = vi.fn(async () => 'source');
    const runner = vi.fn(async () => { controller.abort(); return read(); });
    const provider = new CodexCliProvider({}, runner);
    await expect(provider.produceOutline('explain', { ...ctx(), signal: controller.signal, readFile })).rejects.toThrow();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('does not turn evidence into success when cancellation occurs during a callback', async () => {
    const controller = new AbortController();
    const { provider, requests } = setup([read(), final()]);
    await expect(provider.produceOutline('explain', { ...ctx(), signal: controller.signal, readFile: async () => { controller.abort(); return 'source'; } })).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it('isolates formatting retries and domain validators across concurrent public calls', async () => {
    const counts = new Map<string, number>();
    const runner: CodexCompletionRunner = async (request) => {
      const hydrate = request.prompt.includes('hydrating ONE step');
      const key = hydrate ? 'hydrate' : 'outline';
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      await Promise.resolve();
      if (hydrate) return count === 1 ? envelope('{}') : final({ changeKind: 'delete' });
      return count === 1 ? read() : count === 2 ? envelope('{}') : final();
    };
    const provider = new CodexCliProvider({}, runner);
    const [result, hydrated] = await Promise.all([
      provider.produceOutline('explain', ctx()),
      provider.hydrateStep(step, {}, { sessionId: 'old', workspaceRoot: '/repo' }),
    ]);
    expect(result.problemSummary).toBe(outline.problemSummary);
    expect(hydrated.changeKind).toBe('delete');
    expect(Object.fromEntries(counts)).toEqual({ outline: 3, hydrate: 2 });
  });
});
