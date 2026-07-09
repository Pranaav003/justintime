import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * Downloads a VS Code build and launches a headless Extension Host running the
 * compiled suite (dist-e2e/suite.js) against the fixture workspace. Requires
 * network (to fetch VS Code) and a display/xvfb — run locally or in CI.
 * Bundled to CJS by esbuild, so __dirname is available at runtime.
 */
async function main(): Promise<void> {
  const here = __dirname; // dist-e2e/
  const projectRoot = path.resolve(here, '..');
  const extensionDevelopmentPath = projectRoot;
  const extensionTestsPath = path.resolve(here, 'suite.js');
  const fixture = path.resolve(projectRoot, 'test/e2e/fixture');

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [fixture, '--disable-extensions', '--disable-workspace-trust'],
  });
}

main().catch((err) => {
  console.error('E2E run failed:', err);
  process.exit(1);
});
