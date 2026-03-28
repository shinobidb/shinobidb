import { execFileSync } from 'node:child_process';

describe('CLI', () => {
  it('should show help text', () => {
    const result = execFileSync('npx', ['tsx', 'src/cli.ts', '--help'], { encoding: 'utf-8' });
    expect(result).toContain('shinobidb');
    expect(result).toContain('scan');
    expect(result).toContain('config');
    expect(result).toContain('mask');
  });

  it('should show version', () => {
    const result = execFileSync('npx', ['tsx', 'src/cli.ts', '--version'], { encoding: 'utf-8' });
    expect(result.trim()).toBe('0.0.1');
  });

  it('should show scan command help', () => {
    const result = execFileSync('npx', ['tsx', 'src/cli.ts', 'scan', '--help'], {
      encoding: 'utf-8',
    });
    expect(result).toContain('--host');
    expect(result).toContain('--port');
    expect(result).toContain('--user');
    expect(result).toContain('--password');
  });

  it('should show config command help', () => {
    const result = execFileSync('npx', ['tsx', 'src/cli.ts', 'config', '--help'], {
      encoding: 'utf-8',
    });
    expect(result).toContain('--output');
    expect(result).toContain('--min-confidence');
  });

  it('should show mask command help', () => {
    const result = execFileSync('npx', ['tsx', 'src/cli.ts', 'mask', '--help'], {
      encoding: 'utf-8',
    });
    expect(result).toContain('--config');
    expect(result).toContain('--source-password');
    expect(result).toContain('--target-password');
  });
});
