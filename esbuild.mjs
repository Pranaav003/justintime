import { existsSync } from 'node:fs';
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/**
 * Extension-host bundle. The VS Code extension host loads this via require(),
 * so it must be CommonJS. `vscode` is provided by the host at runtime and must
 * stay external. ESM-only dependencies (e.g. the Claude Agent SDK) are bundled
 * and transpiled to CJS by esbuild.
 * @type {import('esbuild').BuildOptions}
 */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

/**
 * Webview client bundle. Runs in the browser-like webview context and is loaded
 * via a <script nonce> tag, so it must have no Node built-ins.
 * @type {import('esbuild').BuildOptions}
 */
const webviewConfig = {
  entryPoints: ['src/webview/client.ts'],
  bundle: true,
  outfile: 'dist/panel.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
};

// The webview client is introduced in a later task; only build it once it exists.
const configs = [extensionConfig];
if (existsSync('src/webview/client.ts')) {
  configs.push(webviewConfig);
}

if (watch) {
  for (const config of configs) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  }
  console.log('esbuild: watching for changes...');
} else {
  await Promise.all(configs.map((config) => esbuild.build(config)));
  console.log('esbuild: build complete');
}
