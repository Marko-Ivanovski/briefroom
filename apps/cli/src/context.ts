import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { CliError } from './errors.ts';
import { resolveCommand } from './resolve-command.ts';

/** Everything a command touches outside its own arguments, so tests can replace it. */
export interface Context {
  home: string;
  cwd: string;
  hostname: string;
  fetch: typeof fetch;
  out(text: string): void;
  err(text: string): void;
  openUrl(url: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  choose(prompt: string, options: string[]): Promise<number>;
  /** True when both input and output are a terminal, so a question can be asked. */
  interactive: boolean;
  confirm(prompt: string): Promise<boolean>;
  /** Runs a program with an argument array and no shell. Rejects on a non-zero exit. */
  exec(file: string, args: string[], cwd: string): Promise<void>;
  /** Absolute path of a program found in the absolute PATH entries, never in the working directory. */
  resolveCommand(name: string): string | null;
}

// No shell is involved, so a url from the server cannot inject a command.
// The program is always an absolute path, so a file in the working directory is never started.
function openCommand(url: string): [string, string[]] {
  if (process.platform === 'win32') {
    const rundll = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe');
    if (!existsSync(rundll)) throw new Error('rundll32 was not found');
    return [rundll, ['url.dll,FileProtocolHandler', url]];
  }
  const name = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const opener = resolveCommand(name, process.env, process.platform);
  if (!opener) throw new Error(`${name} was not found on PATH`);
  return [opener, [url]];
}

function openUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return Promise.reject(new Error('Refusing to open a non-http url'));
  }
  let command: [string, string[]];
  try {
    command = openCommand(parsed.href);
  } catch (err) {
    return Promise.reject(err as Error);
  }
  const [cmd, args] = command;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function choose(prompt: string, options: string[]): Promise<number> {
  if (!process.stdin.isTTY) {
    throw new CliError('Several workspaces are saved. Pick one with --workspace <name or id>.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const list = options.map((o, i) => `  ${i + 1}) ${o}`).join('\n');
    for (;;) {
      const answer = Number(await rl.question(`${prompt}\n${list}\nNumber: `));
      if (Number.isInteger(answer) && answer >= 1 && answer <= options.length) return answer - 1;
    }
  } finally {
    rl.close();
  }
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${prompt} `)).trim());
  } finally {
    rl.close();
  }
}

function exec(file: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

export function defaultContext(): Context {
  return {
    home: homedir(),
    cwd: process.cwd(),
    hostname: hostname(),
    fetch: globalThis.fetch,
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    openUrl,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    choose,
    interactive: process.stdin.isTTY && process.stdout.isTTY,
    confirm,
    exec,
    resolveCommand: (name) => resolveCommand(name, process.env, process.platform),
  };
}
