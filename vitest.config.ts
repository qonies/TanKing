import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // M5：覆盖率工具链（测试文档 L1：行覆盖率 ≥85%，shared/sim ≥95%）
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      include: ['shared/**/*.ts', 'server/**/*.ts'],
      thresholds: {
        lines: 85,
        functions: 80,
      },
    },
  },
});
