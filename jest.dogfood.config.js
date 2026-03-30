export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/dogfood/**/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, diagnostics: { ignoreCodes: [151002, 1343] } }],
    'node_modules/(p-limit|yocto-queue)/.*\\.js$': ['ts-jest', { useESM: true }],
  },
  transformIgnorePatterns: ['node_modules/(?!(p-limit|yocto-queue|execa|strip-final-newline|npm-run-path|path-key|onetime|mimic-function|human-signals|is-stream|get-stream|signal-exit|is-plain-obj)/)'],
  extensionsToTreatAsEsm: ['.ts'],
  testTimeout: 180_000,
};
