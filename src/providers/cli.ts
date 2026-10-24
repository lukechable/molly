import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { CliLogin } from './types.js';

const exec = promisify(execFile);

export async function onPath(bin: string): Promise<boolean> {
  try {
    await exec('which', [bin], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** A login that runs `bin args…` interactively in the user's terminal. */
export function cliLogin(label: string, bin: string, args: string[]): CliLogin {
  return {
    label,
    available: () => onPath(bin),
    run: () =>
      new Promise((resolve) => {
        const child = spawn(bin, args, { stdio: 'inherit' });
        child.on('exit', () => resolve());
        child.on('error', () => resolve());
      }),
  };
}
