module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/simple-*.test.ts'],
  collectCoverageFrom: [
    'src/simple-*.ts',
    'src/signals.ts',
    '!src/**/*.d.ts',
    '!src/__tests__/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html']
};