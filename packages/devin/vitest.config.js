import { defineConfig } from 'vitest/config';

export default defineConfig({ resolve: { alias: { astra: '@astragate/plugin-sdk/runtime' } }, test: { include: ['test/**/*.test.js'] } });
