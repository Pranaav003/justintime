import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanProvider } from './plan-source';

const fake = vi.hoisted(() => ({
  commands: new Map<string, () => unknown>(),
  panels: [] as { close: () => void; disposed: number }[],
  orchestrators: [] as { dispose: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; provider: PlanProvider }[],
  config: new Map<string, unknown>(),
  userConfig: new Map<string, unknown>(),
  folderConfig: new Map<string, unknown>(),
  singleFolderInspectAlias: false,
  noWorkspace: false,
  codexRun: vi.fn(),
  pick: vi.fn(),
  input: vi.fn(),
  update: vi.fn(),
  storeSecret: vi.fn(),
  info: vi.fn(),
  secret: vi.fn(),
  claude: vi.fn(),
  errors: vi.fn(),
  init: vi.fn(),
  revert: vi.fn(),
}));
vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() { return fake.noWorkspace ? undefined : [{ uri: { fsPath: '/workspace' } }]; },
    getConfiguration: (_section: string, resource?: unknown) => ({
      get: (key: string, fallback: unknown) => resource && key !== 'provider' && key !== 'model' && fake.folderConfig.has(key) ? fake.folderConfig.get(key)
        : fake.config.has(key) ? fake.config.get(key) : fake.userConfig.has(key) ? fake.userConfig.get(key) : fallback,
      inspect: (key: string) => {
        const singleFolder = resource && fake.singleFolderInspectAlias && (key === 'provider' || key === 'model');
        return { globalValue: fake.userConfig.get(key), defaultValue: undefined, workspaceValue: singleFolder ? undefined : fake.config.get(key), workspaceFolderValue: singleFolder ? fake.config.get(key) : resource ? fake.folderConfig.get(key) : undefined };
      },
      update: fake.update,
    }),
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    showErrorMessage: fake.errors,
    showInformationMessage: fake.info,
    showQuickPick: fake.pick,
    showInputBox: fake.input,
  },
  commands: { registerCommand: (name: string, fn: () => unknown) => { fake.commands.set(name, fn); return { dispose() {} }; } },
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}));
vi.mock('./orchestrator', () => ({ Orchestrator: class {
  dispose = vi.fn();
  start = vi.fn(async () => {});
  constructor(readonly provider: PlanProvider) { fake.orchestrators.push(this); }
  getState() { return { phase: 'waiting_for_apply' }; }
} }));
vi.mock('./editor-bridge', () => ({ EditorBridge: class { dispose() {} } }));
vi.mock('./webview/panel', () => ({ ExplanationPanel: class {
  disposed = 0;
  handler?: () => void;
  constructor() { fake.panels.push(this); }
  onDidDispose(handler: () => void) { this.handler = handler; }
  close = () => this.handler?.();
  dispose() { this.disposed++; this.close(); }
} }));
vi.mock('./rollback-store', () => ({ RollbackStore: class { static forWorkspace(...args: unknown[]) { return fake.init(...args); } } }));
vi.mock('./vscode-snapshot-fs', () => ({ VscodeSnapshotFs: class {} }));
vi.mock('./claude-bridge', () => ({ ClaudeAgentProvider: class {
  constructor(query: unknown, config: unknown) { fake.claude(query, config); }
} }));
vi.mock('./sdk-adapter', () => ({ makeClaudeQuery: vi.fn() }));
vi.mock('./codex-cli', () => ({ runCodexCompletion: fake.codexRun }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const provider = { produceOutline: vi.fn(), hydrateStep: vi.fn() };
async function setup() {
  const module = await import('./extension');
  const api = module.activate({
    subscriptions: [], extensionUri: {}, globalStorageUri: { fsPath: '/storage' },
  } as never);
  api.setProviderFactory(() => provider);
  return { api, ...module };
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  fake.commands.clear(); fake.panels.length = 0; fake.orchestrators.length = 0;
  fake.config.clear();
  fake.userConfig.clear();
  fake.folderConfig.clear();
  fake.singleFolderInspectAlias = false;
  fake.noWorkspace = false;
  vi.clearAllMocks();
  fake.codexRun.mockReset(); fake.pick.mockReset(); fake.input.mockReset();
  fake.update.mockImplementation(async (key: string, value: unknown, target: number) => {
    if (target === 2 && fake.noWorkspace) throw new Error('No workspace settings available');
    if (target === 3 && (key === 'provider' || key === 'model')) throw new Error(`Unable to write to Folder Settings because justintime.${key} does not support the folder resource scope.`);
    const values = target === 3 ? fake.folderConfig : target === 2 ? fake.config : fake.userConfig;
    if (value === undefined) values.delete(key); else values.set(key, value);
  });
  fake.secret.mockResolvedValue(undefined);
  fake.revert.mockResolvedValue({ restored: 1, deleted: 0, errors: [] });
  fake.init.mockResolvedValue({ revertAll: fake.revert });
});

afterEach(() => vi.unstubAllGlobals());

describe('application lifetime and workspace recovery', () => {
  it('deactivation invalidates pending construction and repeated teardown is silent', async () => {
    const { api, deactivate } = await setup();
    const gate = deferred<typeof provider>();
    api.setProviderFactory(() => gate.promise);
    const pending = api.start('pending');
    deactivate(); deactivate();
    gate.resolve(provider);
    await pending;
    expect(fake.panels).toHaveLength(0);
    expect(fake.errors).not.toHaveBeenCalled();
  });
  it('closing the active panel invalidates a pending replacement factory', async () => {
    const { api } = await setup();
    await api.start('first');
    const gate = deferred<typeof provider>();
    api.setProviderFactory(() => gate.promise);
    const pending = api.start('pending');
    fake.panels[0]!.close();
    gate.resolve(provider);
    await pending;
    expect(fake.panels).toHaveLength(1);
    expect(fake.orchestrators[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(api.getState()).toBeUndefined();
  });
  it('intentional replacement is functional and disposes the old conductor', async () => {
    const { api } = await setup();
    await api.start('first');
    await api.start('second');
    expect(fake.panels).toHaveLength(2);
    expect(fake.orchestrators[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(fake.orchestrators[1]!.start).toHaveBeenCalledWith('second', 'solve');
    expect(api.getState()).toBeDefined();
    expect(fake.init).toHaveBeenCalledTimes(1);
  });
  it('stale factory rejection never posts an obsolete error', async () => {
    const { api } = await setup();
    const gate = deferred<typeof provider>();
    api.setProviderFactory(() => gate.promise);
    const pending = api.start('old');
    api.setProviderFactory(() => provider);
    await api.start('new');
    gate.reject(new Error('obsolete'));
    await pending;
    expect(fake.errors).not.toHaveBeenCalled();
    expect(fake.panels).toHaveLength(1);
  });
  it('current factory failure preserves the existing walkthrough', async () => {
    const { api } = await setup();
    await api.start('first');
    api.setProviderFactory(async () => { throw new Error('bad configuration'); });
    await api.start('second');
    expect(fake.errors).toHaveBeenCalledWith(expect.stringContaining('bad configuration'));
    expect(fake.orchestrators[0]!.dispose).not.toHaveBeenCalled();
    expect(api.getState()).toBeDefined();
  });
  it('Revert All command works before any walkthrough and awaits recovery', async () => {
    const { api } = await setup();
    expect(api.getState()).toBeUndefined();
    await fake.commands.get('justintime.revertAll')!();
    expect(fake.revert).toHaveBeenCalledTimes(1);
    await api.revertAll();
    expect(fake.init).toHaveBeenCalledTimes(1);
    expect(fake.revert).toHaveBeenCalledTimes(2);
  });
  it('failed journal initialization reports the error and retries later', async () => {
    const { api } = await setup();
    fake.init.mockRejectedValueOnce(new Error('journal unavailable'));
    await api.start('first');
    expect(fake.errors).toHaveBeenCalledWith(expect.stringContaining('journal unavailable'));
    expect(fake.panels).toHaveLength(0);
    await api.start('retry');
    expect(fake.init).toHaveBeenCalledTimes(2);
    expect(fake.panels).toHaveLength(1);
  });
  it('deactivation during journal loading cannot construct a panel', async () => {
    const { api, deactivate } = await setup();
    const gate = deferred<{ revertAll: typeof fake.revert }>();
    fake.init.mockReturnValueOnce(gate.promise);
    const pending = api.start('pending');
    await Promise.resolve();
    deactivate();
    gate.resolve({ revertAll: fake.revert });
    await pending;
    expect(fake.panels).toHaveLength(0);
  });
  it('command errors are reported without rejected command promises', async () => {
    await setup();
    fake.init.mockRejectedValueOnce(new Error('denied journal'));
    await expect(fake.commands.get('justintime.revertAll')!()).resolves.toBeUndefined();
    expect(fake.errors).toHaveBeenCalledWith(expect.stringContaining('denied journal'));
  });
  it('Revert All invalidates factories and closes live sessions before recovery', async () => {
    const { api } = await setup();
    await api.start('first');
    const gate = deferred<typeof provider>();
    api.setProviderFactory(() => gate.promise);
    const pending = api.start('pending');
    await api.revertAll();
    gate.resolve(provider);
    await pending;
    expect(fake.panels).toHaveLength(1);
    expect(fake.orchestrators[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(fake.revert).toHaveBeenCalledTimes(1);
  });
});

describe('default provider sampling boundary', () => {
  it.each([
    { selected: 'ollama', configuredUrl: undefined, model: undefined, endpoint: 'http://localhost:11434/v1/chat/completions', wantModel: 'llama3.1', wantTemperature: null },
    { selected: 'openai', configuredUrl: undefined, model: ' \t ', endpoint: 'https://api.openai.com/v1/chat/completions', wantModel: ' \t ', wantTemperature: 0 },
    { selected: 'ollama', configuredUrl: undefined, model: ' \t ', endpoint: 'http://localhost:11434/v1/chat/completions', wantModel: ' \t ', wantTemperature: null },
    { selected: 'openai', configuredUrl: undefined, model: undefined, endpoint: 'https://api.openai.com/v1/chat/completions', wantModel: 'gpt-4o', wantTemperature: 0 },
    { selected: 'custom', configuredUrl: 'https://custom.example/v1', model: 'chosen-model', endpoint: 'https://custom.example/v1/chat/completions', wantModel: 'chosen-model', wantTemperature: 0 },
    { selected: 'unknown', configuredUrl: 'https://fallback.example/v1', model: 'unknown-model', endpoint: 'https://fallback.example/v1/chat/completions', wantModel: 'unknown-model', wantTemperature: 0 },
    { selected: 'openai', configuredUrl: 'http://localhost:11434/v1', model: 'local-profile', endpoint: 'http://localhost:11434/v1/chat/completions', wantModel: 'local-profile', wantTemperature: 0 },
  ])('uses selected $selected identity for endpoint sampling defaults ($configuredUrl)', async ({ selected, configuredUrl, model, endpoint, wantModel, wantTemperature }) => {
    fake.config.set('provider', selected);
    if (configuredUrl) fake.config.set('baseUrl', configuredUrl);
    if (model) fake.config.set('model', model);
    fake.secret.mockImplementation(async (key: string) => `test-key:${key}`);
    const requests: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> });
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Public answer.' } }] }) };
    });
    const { activate } = await import('./extension');
    const api = activate({
      subscriptions: [], extensionUri: {}, globalStorageUri: { fsPath: '/storage' },
      secrets: { get: fake.secret },
    } as never);
    // Use the real factory and provider, with only fetch and the VS Code host mocked.
    await api.start('problem');
    const actualProvider = fake.orchestrators[0]!.provider;
    expect(await actualProvider.answerQuestion!('question', '', { workspaceRoot: '/workspace' })).toBe('Public answer.');
    expect(fake.errors).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(endpoint);
    expect(requests[0]!.body.model).toBe(wantModel);
    expect(requests[0]!.headers.Authorization).toBe(`Bearer test-key:justintime.key.${selected}`);
    if (wantTemperature === null) expect(requests[0]!.body).not.toHaveProperty('temperature');
    else expect(requests[0]!.body.temperature).toBe(0);
    expect(requests[0]!.body).not.toHaveProperty('reasoning_effort');
  });

  it.each(['chosen-claude', ' \t '])('leaves Claude model %j unchanged and does not add sampling options', async (model) => {
    fake.config.set('provider', 'claude-agent-sdk');
    fake.config.set('claudeExecutable', '/configured/claude');
    fake.config.set('model', model);
    fake.config.set('maxSteps', 31);
    fake.secret.mockResolvedValue('test-claude-key');
    const { activate } = await import('./extension');
    await activate({
      subscriptions: [], extensionUri: {}, globalStorageUri: { fsPath: '/storage' },
      secrets: { get: fake.secret },
    } as never).start('problem');
    expect(fake.errors).not.toHaveBeenCalled();
    expect(fake.claude).toHaveBeenCalledWith(undefined, {
      maxSteps: 31, model, claudeExecutable: '/configured/claude', apiKey: 'test-claude-key',
    });
  });
});

describe('optional Codex CLI provider wiring', () => {
  it.each([
    { model: undefined, globalExecutable: '/trusted/user-codex', mergedExecutable: '/workspace/malicious-codex', wantModel: 'gpt-6-sol', wantExecutable: '/trusted/user-codex' },
    { model: ' \t\n ', globalExecutable: undefined, mergedExecutable: '/workspace/malicious-codex', wantModel: 'gpt-6-sol', wantExecutable: undefined },
    { model: '', globalExecutable: undefined, mergedExecutable: '/workspace/malicious-codex', wantModel: 'gpt-6-sol', wantExecutable: undefined },
    { model: 'selected-model', globalExecutable: '/trusted/other-codex', mergedExecutable: '/workspace/malicious-codex', wantModel: 'selected-model', wantExecutable: '/trusted/other-codex' },
  ])('runs configured $wantModel through native-login transport and trusted machine preference', async ({ model, globalExecutable, mergedExecutable, wantModel, wantExecutable }) => {
    fake.config.set('provider', 'codex-cli');
    if (model !== undefined) fake.config.set('model', model);
    fake.config.set('codexExecutable', mergedExecutable);
    if (globalExecutable) fake.userConfig.set('codexExecutable', globalExecutable);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    fake.codexRun
      .mockResolvedValueOnce(JSON.stringify({ content: '', tool_calls: [{ name: 'read_files', paths: ['a.ts'], query: '' }] }))
      .mockResolvedValueOnce(JSON.stringify({ content: 'Public Codex answer.', tool_calls: [] }));
    const { activate } = await import('./extension');
    const api = activate({
      subscriptions: [], extensionUri: {}, globalStorageUri: { fsPath: '/storage' },
      secrets: { get: fake.secret, store: fake.storeSecret },
    } as never);
    await api.start('problem');
    expect(fake.errors).not.toHaveBeenCalled();
    const reads: string[] = [];
    const answer = await fake.orchestrators[0]!.provider.answerQuestion!('question', '', {
      workspaceRoot: '/workspace', repoMap: ['a.ts'],
      readFile: async (file) => { reads.push(file); return 'const liveEditorValue = 1;'; },
    });
    expect(answer).toBe('Public Codex answer.');
    expect(reads).toEqual(['a.ts']);
    expect(fake.codexRun).toHaveBeenCalledTimes(2);
    for (const [request] of fake.codexRun.mock.calls) {
      expect(request.model).toBe(wantModel);
      expect(request.executable).toBe(wantExecutable);
      expect(request.prompt).not.toContain('/workspace');
    }
    expect(fake.secret).not.toHaveBeenCalled();
    expect(fake.storeSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('picker selects the accepted Codex model with existing login without asking for an API key', async () => {
    fake.config.set('model', 'previous-provider-model');
    fake.pick.mockResolvedValue({ id: 'codex-cli', label: 'Codex CLI' });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { activate } = await import('./extension');
    activate({
      subscriptions: [], extensionUri: {}, globalStorageUri: { fsPath: '/storage' },
      secrets: { get: fake.secret, store: fake.storeSecret },
    } as never);
    await fake.commands.get('justintime.setApiKey')!();
    const vscode = await import('vscode');
    const effective = vscode.workspace.getConfiguration('justintime');
    expect(effective.get('provider')).toBe('codex-cli');
    expect(effective.get('model')).toBe('gpt-6-sol');
    expect(fake.pick.mock.calls[0]![0]).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'codex-cli', description: expect.stringMatching(/login/i) })]));
    expect(fake.input).not.toHaveBeenCalled();
    expect(fake.secret).not.toHaveBeenCalled();
    expect(fake.storeSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(fake.info).toHaveBeenCalledWith(expect.stringMatching(/Codex.*login/i));
  });

  it.each([false, true])('replaces window-scoped workspace overrides when selecting Codex (single-folder inspect=%s)', async (singleFolder) => {
    fake.singleFolderInspectAlias = singleFolder;
    fake.userConfig.set('provider', 'codex-cli'); fake.userConfig.set('model', 'deliberate-global-model');
    fake.config.set('provider', 'ollama'); fake.config.set('model', 'gemma4:12b-it-q4_K_M');
    fake.config.set('unrelatedPreference', 'keep');
    fake.folderConfig.set('unrelatedPreference', 'keep-folder');
    fake.pick.mockResolvedValue({ id: 'codex-cli' });
    const { activate } = await import('./extension');
    activate({ subscriptions: [], extensionUri: {}, globalStorageUri: { fsPath: '/storage' }, secrets: { get: fake.secret, store: fake.storeSecret } } as never);
    await fake.commands.get('justintime.setApiKey')!();
    const vscode = await import('vscode');
    const effective = vscode.workspace.getConfiguration('justintime', vscode.workspace.workspaceFolders![0]!.uri);
    expect(effective.get('provider')).toBe('codex-cli');
    expect(effective.get('model')).toBe('gpt-6-sol');
    expect(fake.config.get('unrelatedPreference')).toBe('keep');
    expect(fake.folderConfig.get('unrelatedPreference')).toBe('keep-folder');
    expect(fake.update.mock.calls.some(([key, , target]) => (key === 'provider' || key === 'model') && target === 3)).toBe(false);
    expect(fake.secret).not.toHaveBeenCalled(); expect(fake.storeSecret).not.toHaveBeenCalled();
  });

  it('constructs Codex after the picker clears single-folder Ollama settings through the Workspace target', async () => {
    const fetch = vi.fn(async () => { throw new Error('Network is forbidden in picker regression tests'); });
    vi.stubGlobal('fetch', fetch);
    fake.singleFolderInspectAlias = true;
    fake.config.set('provider', 'ollama'); fake.config.set('model', 'gemma4:12b-it-q4_K_M');
    fake.pick.mockResolvedValue({ id: 'codex-cli' });
    fake.codexRun
      .mockResolvedValueOnce(JSON.stringify({ content: '', tool_calls: [{ name: 'read_files', paths: ['a.ts'], query: '' }] }))
      .mockResolvedValueOnce(JSON.stringify({ content: 'Selected Codex answer.', tool_calls: [] }));
    const { activate } = await import('./extension');
    const api = activate({ subscriptions: [], extensionUri: {}, globalStorageUri: { fsPath: '/storage' }, secrets: { get: fake.secret, store: fake.storeSecret } } as never);
    await fake.commands.get('justintime.setApiKey')!();
    await api.start('problem');
    expect(fake.errors).not.toHaveBeenCalled();
    expect(fake.config.has('provider')).toBe(false);
    expect(fake.config.has('model')).toBe(false);
    const selected = fake.orchestrators.at(-1)!.provider;
    await expect(selected.answerQuestion!('why?', '', { workspaceRoot: '/workspace', repoMap: ['a.ts'], readFile: async () => 'source' })).resolves.toBe('Selected Codex answer.');
    expect(fake.codexRun).toHaveBeenCalledTimes(2);
    expect(fake.codexRun.mock.calls[0][0].model).toBe('gpt-6-sol');
    expect(fake.update).toHaveBeenCalledWith('provider', undefined, 2);
    expect(fake.update).toHaveBeenCalledWith('model', undefined, 2);
    expect(fake.errors).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'global alternative', global: { provider: 'codex-cli', model: 'gpt-6-luna' }, workspace: {}, alias: false, want: 'gpt-6-luna' },
    { name: 'workspace over other global provider', global: { provider: 'openai', model: 'gpt-4o' }, workspace: { provider: 'codex-cli', model: 'workspace-choice' }, alias: false, want: 'workspace-choice' },
    { name: 'single-folder alias', global: { provider: 'ollama', model: 'llama3.1' }, workspace: { provider: 'codex-cli', model: 'gpt-6-luna' }, alias: true, want: 'gpt-6-luna' },
    { name: 'blank workspace hides global alternative', global: { provider: 'codex-cli', model: 'global-alternative' }, workspace: { model: '' }, alias: true, want: 'gpt-6-sol' },
    { name: 'whitespace workspace', global: { provider: 'codex-cli', model: 'global-alternative' }, workspace: { model: ' \t\n ' }, alias: false, want: 'gpt-6-sol' },
    { name: 'missing model', global: { provider: 'codex-cli' }, workspace: {}, alias: false, want: 'gpt-6-sol' },
    { name: 'padded deliberate model', global: { provider: 'codex-cli', model: ' deliberate-model ' }, workspace: {}, alias: false, want: ' deliberate-model ' },
  ])('reselects effective Codex without changing settings or scopes: $name', async ({ global, workspace, alias, want }) => {
    for (const [key, value] of Object.entries(global)) fake.userConfig.set(key, value);
    for (const [key, value] of Object.entries(workspace)) fake.config.set(key, value);
    fake.singleFolderInspectAlias = alias;
    const before = { global: [...fake.userConfig], workspace: [...fake.config], folder: [...fake.folderConfig] };
    fake.pick.mockResolvedValue({ id: 'codex-cli' });
    fake.codexRun
      .mockResolvedValueOnce(JSON.stringify({ content: '', tool_calls: [{ name: 'read_files', paths: ['a.ts'], query: '' }] }))
      .mockResolvedValueOnce(JSON.stringify({ content: 'Answer grounded in source.', tool_calls: [] }));
    const { activate } = await import('./extension');
    const api = activate({ subscriptions: [], extensionUri: {}, globalStorageUri: { fsPath: '/storage' }, secrets: { get: fake.secret, store: fake.storeSecret } } as never);
    await fake.commands.get('justintime.setApiKey')!();
    expect({ global: [...fake.userConfig], workspace: [...fake.config], folder: [...fake.folderConfig] }).toEqual(before);
    expect(fake.update).not.toHaveBeenCalled();
    await api.start('problem');
    await fake.orchestrators.at(-1)!.provider.answerQuestion!('why?', '', { workspaceRoot: '/workspace', repoMap: ['a.ts'], readFile: async () => 'source' });
    expect(fake.codexRun.mock.calls.map(([request]) => request.model)).toEqual([want, want]);
    expect(fake.input).not.toHaveBeenCalled();
    expect(fake.secret).not.toHaveBeenCalled(); expect(fake.storeSecret).not.toHaveBeenCalled();
    expect(fake.errors).not.toHaveBeenCalled();
  });

  it.each(['openai', 'codex-cli'])('selects Codex without a workspace from %s', async (previous) => {
    fake.noWorkspace = true;
    fake.userConfig.set('provider', previous); fake.userConfig.set('model', 'deliberate-model');
    fake.pick.mockResolvedValue({ id: 'codex-cli' });
    const { activate } = await import('./extension');
    activate({ subscriptions: [], extensionUri: {}, globalStorageUri: { fsPath: '/storage' }, secrets: { get: fake.secret, store: fake.storeSecret } } as never);
    await fake.commands.get('justintime.setApiKey')!();
    expect(fake.userConfig.get('provider')).toBe('codex-cli');
    expect(fake.userConfig.get('model')).toBe(previous === 'codex-cli' ? 'deliberate-model' : 'gpt-6-sol');
    if (previous === 'codex-cli') expect(fake.update).not.toHaveBeenCalled();
    expect(fake.update.mock.calls.every(([, , target]) => target === 1)).toBe(true);
    expect(fake.input).not.toHaveBeenCalled(); expect(fake.secret).not.toHaveBeenCalled(); expect(fake.storeSecret).not.toHaveBeenCalled();
    expect(fake.errors).not.toHaveBeenCalled();
  });

  it.each([false, true])('cancelling provider selection preserves configuration (no workspace=%s)', async (noWorkspace) => {
    fake.noWorkspace = noWorkspace;
    fake.userConfig.set('provider', 'codex-cli'); fake.userConfig.set('model', 'gpt-6-luna');
    fake.pick.mockResolvedValue(undefined);
    const { activate } = await import('./extension');
    activate({ subscriptions: [], extensionUri: {}, globalStorageUri: { fsPath: '/storage' }, secrets: { get: fake.secret, store: fake.storeSecret } } as never);
    await fake.commands.get('justintime.setApiKey')!();
    expect([...fake.userConfig]).toEqual([['provider', 'codex-cli'], ['model', 'gpt-6-luna']]);
    expect(fake.update).not.toHaveBeenCalled(); expect(fake.info).not.toHaveBeenCalled();
    expect(fake.input).not.toHaveBeenCalled(); expect(fake.secret).not.toHaveBeenCalled(); expect(fake.storeSecret).not.toHaveBeenCalled();
  });

  it('uses the effective provider after the picker resolves', async () => {
    fake.userConfig.set('provider', 'openai'); fake.userConfig.set('model', 'gpt-4o');
    const pick = deferred<{ id: string }>(); fake.pick.mockReturnValue(pick.promise);
    const { activate } = await import('./extension');
    activate({ subscriptions: [], extensionUri: {}, globalStorageUri: { fsPath: '/storage' }, secrets: { get: fake.secret, store: fake.storeSecret } } as never);
    const pending = fake.commands.get('justintime.setApiKey')!();
    fake.config.set('provider', 'codex-cli'); fake.config.set('model', 'late-workspace-choice');
    pick.resolve({ id: 'codex-cli' }); await pending;
    expect(fake.config.get('model')).toBe('late-workspace-choice');
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.errors).not.toHaveBeenCalled();
  });

  it('contributes optional Codex and a machine-only executable while preserving prior defaults', async () => {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const config = manifest.contributes.configuration.properties;
    expect(config['justintime.provider'].enum).toEqual(['claude-agent-sdk', 'openai', 'ollama', 'custom', 'codex-cli']);
    expect(config['justintime.provider'].default).toBe('claude-agent-sdk');
    expect(config['justintime.model'].default).toBe('');
    expect(config['justintime.codexExecutable']).toMatchObject({ type: 'string', default: '', scope: 'machine' });
  });
});
