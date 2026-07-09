import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit + integration tests live next to the code they exercise.
    // VS Code-bound code is covered by the E2E runner, not vitest.
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
