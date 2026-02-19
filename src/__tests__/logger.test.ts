// Note: chalk is mocked globally in setup-mocks.js to handle the colors.ts module
// which uses chalk.hex() at the top level (during module initialization)
import { WoodburyLogger } from '../logger';

describe('WoodburyLogger', () => {
  let logger: WoodburyLogger;
  let consoleSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    logger = new WoodburyLogger(false); // Non-verbose mode
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    errorSpy = jest.spyOn(console, 'error').mockImplementation();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  describe('initialization', () => {
    it('should create logger with verbose flag', () => {
      const verboseLogger = new WoodburyLogger(true);
      expect(verboseLogger).toBeInstanceOf(WoodburyLogger);
    });

    it('should create logger with non-verbose flag', () => {
      const quietLogger = new WoodburyLogger(false);
      expect(quietLogger).toBeInstanceOf(WoodburyLogger);
    });
  });

  describe('info logging', () => {
    it('should log info messages in verbose mode', () => {
      const verboseLogger = new WoodburyLogger(true);
      verboseLogger.info('Test info message');
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should not log info messages in non-verbose mode', () => {
      logger.info('Test info message');
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should log info messages with multiple arguments in verbose mode', () => {
      const verboseLogger = new WoodburyLogger(true);
      verboseLogger.info('Message:', 'value', 123);
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe('error logging', () => {
    it('should log error messages', () => {
      logger.error('Test error message');
      expect(errorSpy).toHaveBeenCalled();
    });

    it('should log error messages with multiple arguments', () => {
      logger.error('Error:', 'details', 500);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('debug logging', () => {
    it('should log debug messages in verbose mode', () => {
      const verboseLogger = new WoodburyLogger(true);
      verboseLogger.debug('Debug message');
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should not log debug messages in non-verbose mode', () => {
      logger.debug('Debug message');
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe('warn logging', () => {
    it('should log warning messages', () => {
      logger.warn('Warning message');
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('verbose mode differences', () => {
    it('verbose logger should log debug messages', () => {
      const verboseLogger = new WoodburyLogger(true);
      verboseLogger.debug('Verbose debug');
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('non-verbose logger should skip debug messages', () => {
      const quietLogger = new WoodburyLogger(false);
      quietLogger.debug('Quiet debug');
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('both modes should log error messages', () => {
      const verboseLogger = new WoodburyLogger(true);
      const quietLogger = new WoodburyLogger(false);
      
      verboseLogger.error('Verbose error');
      quietLogger.error('Quiet error');
      
      expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    it('verbose mode should log info, non-verbose should not', () => {
      const verboseLogger = new WoodburyLogger(true);
      const quietLogger = new WoodburyLogger(false);
      
      verboseLogger.info('Verbose info');
      quietLogger.info('Quiet info');
      
      expect(consoleSpy).toHaveBeenCalledTimes(1); // Only verbose logged
    });
  });
});
