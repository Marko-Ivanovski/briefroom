import { spawn } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { CliError } from './errors.ts';

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
}

// No shell is involved, so a url from the server cannot inject a command.
function openCommand(url: string): [string, string[]] {
  if (process.platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (process.platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

function openUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return Promise.reject(new Error('Refusing to open a non-http url'));
  }
  const [cmd, args] = openCommand(parsed.href);
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
  };
}
