import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [{ find: /^cortico\//, replacement: fileURLToPath(new URL('../Cortico/src/', import.meta.url)) }],
  },
  test: { include: ['tests/**/*.test.ts'], pool: 'forks', maxWorkers: 1, minWorkers: 1 },
});
