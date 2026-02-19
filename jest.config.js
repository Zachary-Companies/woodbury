module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/__tests__/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  
  // Map .js imports to .ts source files for ts-jest
  moduleNameMapper: {
    '^(\\.\\.?/.*)\\.js$': '$1'
  },
  
  // Transform ESM modules
  transformIgnorePatterns: [
    'node_modules/(?!(marked|marked-terminal)/)',
  ],
  
  // Setup file - runs BEFORE test framework is installed
  setupFiles: ['<rootDir>/src/__tests__/setup-mocks.js'],
  
  // Setup file - runs AFTER test framework is installed
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts']
};
