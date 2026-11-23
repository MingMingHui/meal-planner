import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'www/**', 'android/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
  },
];
