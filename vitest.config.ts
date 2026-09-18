import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // Les sous-chemins d'abord : `@cairn/core` seul les avalerait, et le
      // formatage des durées — partagé avec le web — ne se résoudrait plus.
      '@cairn/core/': r('./packages/core/src/'),
      '@cairn/core': r('./packages/core/src/index.ts'),
      '@cairn/physiology': r('./packages/physiology/src/index.ts'),
      '@cairn/coach': r('./packages/coach/src/index.ts'),
      '@cairn/strava': r('./packages/strava/src/index.ts'),
      '@cairn/db': r('./packages/db/src/index.ts'),
    },
  },
});
