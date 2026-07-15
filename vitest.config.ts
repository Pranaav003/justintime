import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit + integration tests live next to the code they exercise.
    // VS Code-bound code is covered by the E2E runner, not vitest.
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Exclude test files, pure type decls, and VS Code-bound modules (E2E-covered).
      exclude: [
        'src/**/*.test.ts',
        'src/types.ts',
        'src/webview/protocol.ts',
        'src/plan-source.ts',
        'src/extension.ts',
        'src/editor-bridge.ts',
        'src/webview/panel.ts',
        'src/webview/client.ts',
        'src/sdk-adapter.ts',
        'src/vscode-snapshot-fs.ts',
      ],
    },
  },
});
