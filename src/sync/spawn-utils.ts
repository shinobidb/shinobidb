import { spawn } from 'node:child_process';

export async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('which', [command], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

export function spawnAndWait(
  command: string,
  args: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    stdout?: NodeJS.WritableStream;
    stdin?: NodeJS.ReadableStream;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options?.env ?? process.env,
    });

    let stdout = '';
    let stderr = '';
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    if (options?.stdin) {
      options.stdin.pipe(proc.stdin);
    } else {
      proc.stdin.end();
    }

    if (options?.stdout) {
      proc.stdout.pipe(options.stdout);
    } else {
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
    }

    proc.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    proc.on('error', reject);
  });
}
