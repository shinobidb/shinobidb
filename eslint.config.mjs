import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import jestPlugin from 'eslint-plugin-jest';
import security from 'eslint-plugin-security';

export default [
  {
    ignores: ['coverage/**', 'dist/**', 'node_modules/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      import: importPlugin,
      security,
    },
    rules: {
      // ① セキュリティ（eslint-plugin-security）
      'security/detect-eval-with-expression': 'error',
      'security/detect-child-process': 'error',
      'security/detect-possible-timing-attacks': 'warn',
      'security/detect-unsafe-regex': 'error',
      'security/detect-non-literal-fs-filename': 'warn',
      'security/detect-non-literal-regexp': 'warn',

      // ② import順序統一
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc' },
        },
      ],

      // ③ 未使用変数・import
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // ④ console.log 禁止（CLIツールはlogger経由で出力すべき）
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // ⑤ any 型の使用禁止
      '@typescript-eslint/no-explicit-any': 'error',

      // ⑥ import 品質ルール
      'import/no-duplicates': 'error',
      'import/newline-after-import': ['error', { count: 1 }],

      // ⑦ 命名規則の強制
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variable',
          format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
        },
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
        {
          selector: 'parameter',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
        },
        { selector: 'typeLike', format: ['PascalCase'] },
        {
          selector: 'variable',
          modifiers: ['destructured'],
          format: null,
        },
        {
          selector: 'parameter',
          modifiers: ['destructured'],
          format: null,
        },
      ],
    },
  },
  // テストファイル専用ルール
  {
    files: ['**/__tests__/**/*.ts'],
    plugins: { jest: jestPlugin },
    rules: {
      'jest/consistent-test-it': ['error', { fn: 'it', withinDescribe: 'it' }],
      'jest/no-focused-tests': 'error',
      'jest/no-disabled-tests': 'warn',
      'jest/no-identical-title': 'error',
      'jest/expect-expect': 'error',
      'jest/valid-expect': 'error',
      'jest/valid-describe-callback': 'error',
      '@typescript-eslint/naming-convention': 'off',
    },
  },
  // Prettier との競合を防止（必ず最後）
  prettierConfig,
];
