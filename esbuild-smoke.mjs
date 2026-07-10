import esbuild from 'esbuild';

// Bundles the real-Claude provider smoke test (see scripts/smoke-real.ts).
// Run: npm run smoke   (needs ANTHROPIC_API_KEY; on a restricted key/gateway set
// JIT_SMOKE_MODEL=claude-sonnet-4-6).
await esbuild.build({
  entryPoints: ['scripts/smoke-real.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['@anthropic-ai/claude-agent-sdk'],
  outfile: 'dist-smoke/smoke.js',
  logLevel: 'error',
});
console.log('smoke bundled');
