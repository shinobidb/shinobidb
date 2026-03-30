import { isInteractiveTerminal } from '../password-prompt.js';

describe('isInteractiveTerminal', () => {
  const originalIsTTY = process.stdin.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, writable: true });
  });

  it('should return true when stdin is a TTY', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true });
    expect(isInteractiveTerminal()).toBe(true);
  });

  it('should return false when stdin is not a TTY', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true });
    expect(isInteractiveTerminal()).toBe(false);
  });

  it('should return false when stdin.isTTY is false', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true });
    expect(isInteractiveTerminal()).toBe(false);
  });
});
