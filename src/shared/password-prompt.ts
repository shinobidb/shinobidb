import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true;
}

export async function promptPassword(label: string): Promise<string> {
  const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });

  process.stderr.write(label);

  try {
    const answer = await rl.question('');
    return answer;
  } finally {
    rl.close();
    process.stderr.write('\n');
  }
}
