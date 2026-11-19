import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Blender integration tests spawn real processes; keep files isolated.
    pool: 'forks',
  },
});
