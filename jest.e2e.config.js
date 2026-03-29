/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/e2e/**/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { useESM: true, diagnostics: { ignoreCodes: [151002] } },
    ],
    'node_modules/(p-limit|yocto-queue)/.*\\.js$': [
      'ts-jest',
      { useESM: true },
    ],
  },
  transformIgnorePatterns: ['node_modules/(?!(p-limit|yocto-queue)/)'],
  extensionsToTreatAsEsm: ['.ts'],
  testTimeout: 120_000,
};
