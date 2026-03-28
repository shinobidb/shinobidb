import { getLogLevel, logger, setLogLevel } from '../logger.js';

describe('logger', () => {
  let stderrSpy: jest.SpyInstance;
  let stdoutSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    stderrSpy = jest.spyOn(console, 'error').mockImplementation();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation();
    setLogLevel('debug');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setLogLevel('info');
  });

  it('should log debug messages when level is debug', () => {
    logger.debug('test debug');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('should not log debug messages when level is info', () => {
    setLogLevel('info');
    logger.debug('test debug');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('should log info messages', () => {
    logger.info('test info');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('should log success messages', () => {
    logger.success('test success');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('should log warn messages', () => {
    logger.warn('test warn');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('should log error messages', () => {
    logger.error('test error');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('should write to stdout via output()', () => {
    logger.output('data output');
    expect(stdoutSpy).toHaveBeenCalledWith('data output\n');
  });

  it('should respect log level hierarchy', () => {
    setLogLevel('error');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should get and set log level', () => {
    setLogLevel('warn');
    expect(getLogLevel()).toBe('warn');
  });
});
