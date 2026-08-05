import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Tests that touch Redis need a moment; the default 5s is tight when
    // a connection has to be established first.
    testTimeout: 10_000,
  },
});
