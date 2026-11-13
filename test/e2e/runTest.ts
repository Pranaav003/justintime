import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

/**
 * Downloads a VS Code build and launches a headless Extension Host running the
 * compiled suite twice against a disposable two-root workspace and profile.
 * The prepare host leaves recovery data; a fresh recover host uses the same
 * workspace/profile to verify explicit recovery across process restarts. Requires
 * network (to fetch VS Code) and a display/xvfb — run locally or in CI.
 * Bundled to CJS by esbuild, so __dirname is available at runtime.
 */
async function main(): Promise<void> {
  const here = __dirname; // dist-e2e/
  const projectRoot = path.resolve(here, '..');
  const extensionDevelopmentPath = projectRoot;
  const extensionTestsPath = path.resolve(here, 'suite.js');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'justintime-e2e-'));
  const firstRoot = path.join(tempDir, 'first-root');
  const secondRoot = path.join(tempDir, 'second-root');
  const workspace = path.join(tempDir, 'justintime.code-workspace');
  const userData = path.join(tempDir, 'user-data');
  const extensions = path.join(tempDir, 'extensions');

  try {
    await fs.cp(path.join(projectRoot, 'test/e2e/fixture'), firstRoot, { recursive: true });
    await fs.mkdir(secondRoot);
    await fs.copyFile(path.join(firstRoot, 'sample.ts'), path.join(secondRoot, 'sample.ts'));
    await fs.writeFile(path.join(secondRoot, 'secondary-only.ts'), 'export const secondaryOnly = true;\n');
    await fs.mkdir(userData);
    await fs.mkdir(extensions);
    await fs.writeFile(workspace, JSON.stringify({
      folders: [{ path: 'first-root' }, { path: 'second-root' }],
      settings: { 'files.autoSave': 'off', 'workbench.startupEditor': 'none' },
    }, null, 2));

    // Resolve once so both phases use the identical VS Code build. The supported
    // test-electron resolver handles current macOS bundles' renamed Code binary.
    const vscodeExecutablePath = await downloadAndUnzipVSCode({ extensionDevelopmentPath });
    for (const phase of ['prepare', 'recover']) {
      console.log(`E2E ${phase}: workspace=${workspace}, profile=${userData}`);
      try {
        await runTests({
          vscodeExecutablePath,
          extensionDevelopmentPath,
          extensionTestsPath,
          extensionTestsEnv: {
            JIT_E2E_PHASE: phase,
            JIT_E2E_TEMP_DIR: tempDir,
            JIT_E2E_FIRST_ROOT: firstRoot,
            JIT_E2E_SECOND_ROOT: secondRoot,
          },
          launchArgs: [
            workspace,
            `--user-data-dir=${userData}`,
            `--extensions-dir=${extensions}`,
            '--disable-extensions',
            '--disable-workspace-trust',
          ],
        });
      } catch (error) {
        throw new Error(`E2E ${phase} failed (workspace=${workspace}, profile=${userData})`, { cause: error });
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('E2E run failed:', err);
  process.exit(1);
});
