const config = {
    clearMocks: true,

    collectCoverage: true,

    coverageDirectory: 'coverage',

    coverageProvider: 'v8',

    testEnvironment: 'node',

    extensionsToTreatAsEsm: ['.ts'],

    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },

    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                useESM: true,
            },
        ],
    },

    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
    coveragePathIgnorePatterns: ['/node_modules/'],
};

export default config;
