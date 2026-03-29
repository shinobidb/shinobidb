import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as {
  version: string;
};

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
    expect(result.trim()).toBe(pkg.version);
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

  it('should show validate command help', () => {
    const result = execFileSync('npx', ['tsx', 'src/cli.ts', 'validate', '--help'], {
      encoding: 'utf-8',
    });
    expect(result).toContain('--config');
    expect(result).toContain('--json');
  });

  it('should list validate in help text', () => {
    const result = execFileSync('npx', ['tsx', 'src/cli.ts', '--help'], { encoding: 'utf-8' });
    expect(result).toContain('validate');
  });
});
