import esbuild from 'esbuild';

/**
 * Builds the E2E harness. runTest.js is a plain node script (fetches VS Code and
 * launches the host); suite.js is loaded by the extension host via require, so
 * both are CJS. `vscode` and the SDK are external.
 */
const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', '@vscode/test-electron', '@anthropic-ai/claude-agent-sdk'],
  sourcemap: true,
  logLevel: 'info',
};

await Promise.all([
  esbuild.build({ ...shared, entryPoints: ['test/e2e/runTest.ts'], outfile: 'dist-e2e/runTest.js' }),
  esbuild.build({ ...shared, entryPoints: ['test/e2e/suite/index.ts'], outfile: 'dist-e2e/suite.js' }),
]);
console.log('e2e build complete');
