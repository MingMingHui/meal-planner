import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { fs: { allow: ['..'] } }, // tests import the shared web app in ../js
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    restoreMocks: true,
  },
});
