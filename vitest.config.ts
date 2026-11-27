import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 这些用例会真写临时目录、跑 650k 次 PBKDF2：并行只会互相拖慢并放大抖动
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/core/**/*.ts', 'src/server/**/*.ts'],
      exclude: ['src/core/test.ts', 'src/core/test-legacy.ts'],
    },
  },
});