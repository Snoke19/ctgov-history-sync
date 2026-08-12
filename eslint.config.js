import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import nodePlugin from 'eslint-plugin-n';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
    js.configs.recommended,
    importPlugin.flatConfigs.recommended,
    nodePlugin.configs['flat/recommended-script'],
    ...tseslint.configs.recommended,

    {
        files: ['**/*.ts'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
        settings: {
            node: {
                version: '>=20.3.0',
            },
        },
        rules: {
            'comma-dangle': ['error', 'always-multiline'],
            'no-trailing-spaces': 'error',
            'eol-last': ['error', 'always'],
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
            'prefer-const': 'error',
            'no-var': 'error',
            'object-shorthand': 'error',
            'prefer-template': 'error',

            'require-atomic-updates': 'error',
            'no-promise-executor-return': 'error',

            'n/no-process-exit': 'error',
            'n/no-unpublished-import': 'off',
            'n/prefer-global/process': ['error', 'always'],
            'n/no-missing-import': 'error',

            'import/no-unresolved': 'error',
            'import/named': 'error',
            'import/order': [
                'warn',
                {
                    groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
                    'newlines-between': 'never',
                    alphabetize: { order: 'asc', caseInsensitive: true },
                },
            ],

            'no-console': ['warn', { allow: ['warn', 'error'] }],

            eqeqeq: ['error', 'always'],
        },
    },

    prettier,

    {
        files: ['eslint.config.ts', '**/*.config.ts'],
        rules: {
            'no-console': 'off',
            'n/no-process-exit': 'off',
        },
    },
    {
        ignores: ['node_modules/**', 'output/**', 'coverage/**', '*.log', '.env'],
    },
];
