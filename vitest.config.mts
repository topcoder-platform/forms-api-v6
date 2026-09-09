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
    include: ['test/**/*.spec.ts'],
    exclude: ['test/**/*.integration.spec.ts'],
  },
});
