import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

export interface CodexCompletionRequest {
  prompt: string;
  model: string;
  schema: Record<string, unknown>;
  workspaceRoot: string;
  workspaceRoots?: string[];
  executable?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  log?: (level: 'error' | 'warn' | 'info', message: string, error?: unknown) => void;
}
export type CodexCompletionRunner = (request: CodexCompletionRequest) => Promise<string>;

const MAX_OUTPUT_BYTES = 1024 * 1024;
const APP_CLI = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const DISABLED_FEATURES = [
  'shell_tool', 'apps', 'plugins', 'hooks', 'skill_mcp_dependency_install',
  'multi_agent', 'view_image', 'browser_use', 'computer_use', 'image_generation', 'code_mode_host',
];

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function launchSpec(request: CodexCompletionRequest): Promise<{ command: string; prefix: string[]; env: NodeJS.ProcessEnv }> {
  const roots: string[] = [];
  for (const root of [request.workspaceRoot, ...(request.workspaceRoots ?? [])]) {
    if (!path.isAbsolute(root)) throw new Error('Codex workspace trust checks require absolute paths');
    roots.push(path.resolve(root));
    try { roots.push(await fs.realpath(root)); } catch { /* An absent workspace still has a lexical boundary. */ }
  }
  const outsideWorkspace = (candidate: string) => {
    if (!path.isAbsolute(candidate) || roots.some(root => contains(root, candidate))) {
      throw new Error('Codex requires trusted absolute paths outside all workspaces');
    }
  };
  const trustedPath = async (candidate: string): Promise<string> => {
    outsideWorkspace(candidate);
    const canonical = await fs.realpath(candidate);
    outsideWorkspace(canonical);
    return canonical;
  };
  // Both lexical and canonical temp roots must stay outside every workspace.
  try { await trustedPath('/tmp'); }
  catch { throw new Error('Codex temporary directory must be outside all workspaces'); }
  const executablePath = async (candidate: string): Promise<string> => {
    const canonical = await trustedPath(candidate);
    const stat = await fs.stat(canonical);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== 0 && stat.uid !== process.getuid())) {
      throw new Error('Codex executable must be a trusted owner-controlled file');
    }
    await fs.access(canonical, constants.X_OK);
    return canonical;
  };
  // Preserve native login storage, but refuse a workspace-supplied auth/config home.
  for (const home of [process.env.HOME ?? os.homedir(), process.env.CODEX_HOME]) {
    if (home) {
      outsideWorkspace(home);
      try { await trustedPath(home); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  const safePath: string[] = [];
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    // Never interpret an empty/relative PATH entry in the workspace or temp cwd.
    if (!entry || !path.isAbsolute(entry)) continue;
    try {
      const canonical = await trustedPath(entry);
      if ((await fs.stat(canonical)).isDirectory()) safePath.push(canonical);
    } catch { /* Unsafe or absent entries are excluded from discovery and child PATH. */ }
  }
  let executable: string | undefined;
  let original: string | undefined;
  if (request.executable !== undefined) {
    if (!request.executable || !path.isAbsolute(request.executable)) throw new Error('Codex executable must be a nonempty absolute path');
    original = request.executable;
    executable = await executablePath(original);
  } else {
    for (const candidate of [APP_CLI, ...safePath.map(dir => path.join(dir, 'codex'))]) {
      try { executable = await executablePath(candidate); original = candidate; break; } catch { /* Try the next trusted installation. */ }
    }
  }
  if (!executable || !original) throw new Error('No trusted Codex CLI found. Set the machine-level Codex executable path.');

  // npm's env-node wrapper must not resolve node from a workspace-controlled PATH.
  const handle = await fs.open(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  let header: string;
  try {
    const bytes = Buffer.alloc(512);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    header = bytes.subarray(0, read.bytesRead).toString('utf8').split('\n', 1)[0];
  } finally { await handle.close(); }
  let command = executable;
  const prefix: string[] = [];
  if (header.startsWith('#!')) {
    const interpreter = header.slice(2).trim();
    const isEnvNode = /^\/usr\/bin\/env[ \t]+node$/.test(interpreter);
    const isAbsoluteNode = path.isAbsolute(interpreter) && /^node(?:\.exe)?$/.test(path.basename(interpreter));
    if (!isEnvNode && !isAbsoluteNode) throw new Error('Codex executable must be native or a trusted Node wrapper');
    const candidates = isAbsoluteNode ? [interpreter] : [
      path.join(path.dirname(original), 'node'),
      ...(path.basename(process.execPath) === 'node' ? [process.execPath] : []),
      ...safePath.map(dir => path.join(dir, 'node')),
      '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node',
    ];
    let node: string | undefined;
    for (const candidate of candidates) {
      try { node = await executablePath(candidate); break; } catch { /* Try a vetted absolute interpreter. */ }
    }
    if (!node) throw new Error('Codex Node wrapper requires a trusted Node interpreter');
    command = node;
    prefix.push(executable);
    safePath.unshift(path.dirname(node));
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [...new Set(safePath)].join(path.delimiter) };
  // Inherited runtime injection can otherwise execute arbitrary code before Codex starts.
  for (const key of Object.keys(env)) {
    if (key === 'NODE_OPTIONS' || key === 'NODE_PATH' || key.startsWith('DYLD_') || key.startsWith('LD_')) delete env[key];
  }
  return { command, prefix, env };
}

export const runCodexCompletion: CodexCompletionRunner = async request => {
  if (request.signal?.aborted) throw new Error('Codex completion cancelled');
  if (process.platform === 'win32') throw new Error('Codex completion currently requires POSIX process-group isolation');
  const timeoutMs = request.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('Codex timeout must be a positive finite timer duration');
  }
  const launch = await launchSpec(request);
  if (request.signal?.aborted) throw new Error('Codex completion cancelled');
  // A fixed system temp root avoids workspace-controlled TMPDIR and repository config.
  const cwd = await fs.mkdtemp('/tmp/justintime-codex-');
  let finalMessage: string;
  try {
    await fs.chmod(cwd, 0o700);
    const schemaPath = path.join(cwd, 'schema.json');
    const outputPath = path.join(cwd, 'final.txt');
    await fs.writeFile(schemaPath, JSON.stringify(request.schema), { mode: 0o600, flag: 'wx' });
    await fs.writeFile(outputPath, '', { mode: 0o600, flag: 'wx' });
    const settings = [
      'approval_policy="never"', 'forced_login_method="chatgpt"',
      'model_reasoning_effort="medium"', 'project_doc_max_bytes=0', 'web_search="disabled"',
    ];
    const args = [
      ...launch.prefix, 'exec', '--ignore-user-config', '--ephemeral', '--json',
      ...DISABLED_FEATURES.flatMap(feature => ['--disable', feature]),
      '--skip-git-repo-check', '--sandbox', 'read-only', '--model', request.model,
      ...settings.flatMap(setting => ['-c', setting]),
      '--output-schema', schemaPath, '--output-last-message', outputPath, '-',
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(launch.command, args, {
        cwd, env: launch.env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const killGroup = () => {
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone, including after leader exit. */ }
        }
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        request.signal?.removeEventListener('abort', abort);
        killGroup();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new Error('Codex completion cancelled'));
      child.on('error', () => finish(new Error('Could not start the trusted Codex CLI')));
      // Descendants can retain pipes after their leader exits and prevent close.
      child.on('exit', killGroup);
      child.on('close', (code, signal) => finish(code === 0 ? undefined : new Error(`Codex CLI failed (${code ?? signal ?? 'unknown exit'})`)));
      // Drain without retaining or logging source, thoughts, or raw native errors.
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.on('error', error => {
        if ((error as NodeJS.ErrnoException).code !== 'EPIPE') finish(new Error('Could not send the Codex completion request'));
      });
      request.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(new Error('Codex completion timed out')), timeoutMs);
      if (request.signal?.aborted) abort(); else child.stdin.end(request.prompt);
    });
    let output: fs.FileHandle;
    try { output = await fs.open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { throw new Error('Codex final message could not be opened safely'); }
    try {
      const stat = await output.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_OUTPUT_BYTES) throw new Error('Codex final message is empty or exceeds the output limit');
      const bytes = Buffer.alloc(MAX_OUTPUT_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await output.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_OUTPUT_BYTES) throw new Error('Codex final message exceeds the output limit');
      finalMessage = bytes.subarray(0, length).toString('utf8');
    } finally { await output.close(); }
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
  // Cancellation may arrive during the async final read, handle close, or cleanup.
  if (request.signal?.aborted) throw new Error('Codex completion cancelled');
  return finalMessage;
};
