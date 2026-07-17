import js from '@eslint/js';
import globals from 'globals';
import importPlugin from 'eslint-plugin-import';
import nodePlugin from 'eslint-plugin-n';
import prettier from 'eslint-config-prettier';

export default [
    js.configs.recommended,
    importPlugin.flatConfigs.recommended,

    nodePlugin.configs['flat/recommended-script'],

    {
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
            // --- Style (match your codebase) ---
            'indent': ['error', 4, {SwitchCase: 1}],
            'quotes': ['error', 'single', {avoidEscape: true}],
            'semi': ['error', 'always'],
            'comma-dangle': ['error', 'always-multiline'],
            'no-trailing-spaces': 'error',
            'eol-last': ['error', 'always'],
            'max-len': ['warn', {code: 120, ignoreUrls: true, ignoreStrings: true}],

            // --- Best practices (critical for scrapers) ---
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_'}],
            'prefer-const': 'error',
            'no-var': 'error',
            'object-shorthand': 'error',
            'prefer-template': 'error',

            // --- Async / Promises (your #1 source of bugs) ---
            'require-atomic-updates': 'error',
            'no-promise-executor-return': 'error',

            // --- Node.js specific ---
            'n/no-process-exit': 'error',
            'n/no-unpublished-import': 'off', // We use --env-file, not dotenv package
            'n/prefer-global/process': ['error', 'always'],
            'n/no-missing-import': 'error',

            // --- Import hygiene ---
            'import/no-unresolved': 'error',
            'import/named': 'error',
            'import/order': ['warn', {
                'groups': ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
                'newlines-between': 'never',
                'alphabetize': {order: 'asc', caseInsensitive: true},
            }],

            // --- Console (you use logger, but allow debug) ---
            'no-console': ['warn', {allow: ['warn', 'error']}],

            // --- Strict equality ---
            'eqeqeq': ['error', 'always'],
        },
    },

    prettier,

    {
        files: ['eslint.config.js', '**/*.config.js'],
        rules: {
            'no-console': 'off',
            'n/no-process-exit': 'off',
        },
    },
    {
        ignores: [
            'node_modules/**',
            'output/**',
            'coverage/**',
            '*.log',
            '.env',
        ],
    },
];
