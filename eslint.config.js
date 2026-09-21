import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const forbiddenDomainImports = [
  '@application/**',
  '@services/**',
  '@ui/**',
  '../../application/**',
  '../../services/**',
  '../../ui/**',
  '../../../worker/**',
  'worker/**',
  '@cloudflare/workers-types'
];

export default tseslint.config(
  {
    ignores: ['.wrangler/**', 'coverage/**', 'dist/**', 'node_modules/**', 'worker-configuration.d.ts']
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2022
      }
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      complexity: ['error', 12]
    }
  },
  {
    files: ['worker/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.worker,
        ...globals.es2022
      }
    }
  },
  {
    files: ['scripts/**/*.mjs', '*.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022
      }
    }
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: forbiddenDomainImports }]
    }
  }
);
