import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        transform: { decoratorMetadata: true, react: { runtime: 'automatic' } },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/keycloak.setup.ts'],
    include: ['test/**/*.integration.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
