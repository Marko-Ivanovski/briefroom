import { spawn } from 'node:child_process';
import type { TunnelMode } from '@briefroom/contracts';

export const BINARIES = {
  tailscaled: '/usr/local/bin/tailscaled',
  tailscale: '/usr/local/bin/tailscale',
  cloudflared: '/usr/local/bin/cloudflared',
} as const;

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
const STABLE_RUN_MS = 60_000;
const STEP_TIMEOUT_MS = 120_000;
const STEP_RETRY_MS = 1_000;
// tailscaled needs a moment before its socket answers, so the login is retried.
const LOGIN_ATTEMPTS = 10;
const STOP_GRACE_MS = 5_000;
const MAX_ERROR_LENGTH = 500;
const REDACTED = '[redacted]';

export type SupervisorStatus = 'off' | 'starting' | 'running' | 'restarting';

export interface SupervisorSnapshot {
  mode: TunnelMode | null;
  status: SupervisorStatus;
  lastError: string | null;
  /** A tunnel daemon is alive and may be forwarding requests to the app over loopback. */
  forwarding: boolean;
}

interface OutputStream {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

export interface ChildProcessLike {
  readonly stdin: {
    end(chunk: string): unknown;
    on(event: 'error', listener: (err: Error) => void): unknown;
  } | null;
  readonly stdout: OutputStream | null;
  readonly stderr: OutputStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export interface SpawnOptions {
  env: Record<string, string>;
  stdio: ['pipe' | 'ignore', 'pipe', 'pipe'];
}

export type SpawnChild = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessLike;

/** No shell, so nothing in an argument is ever interpreted. */
export const spawnProcess: SpawnChild = (command, args, options) =>
  spawn(command, [...args], { ...options, shell: false, windowsHide: true });

export interface SupervisorOptions {
  spawn: SpawnChild;
  port: number;
  stateDir: string;
  /** The whole environment a child gets, plus its own secret. The app's own secrets stay out. */
  env: Record<string, string>;
  logger: { log(message: string): void; warn(message: string): void };
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

interface Step {
  name: string;
  command: string;
  args: string[];
  daemon: boolean;
  env?: Record<string, string>;
  stdin?: string;
  readyPattern?: RegExp;
  attempts?: number;
}

/**
 * Secrets go through the environment (cloudflared reads TUNNEL_TOKEN) or stdin (`tailscale up`
 * reads no env var, but takes `file:` paths), never argv, which `ps` shows to anyone in the container.
 */
export function planFor(mode: TunnelMode, secret: string, port: number, stateDir: string): Step[] {
  if (mode === 'cloudflare') {
    return [
      {
        name: 'cloudflared',
        command: BINARIES.cloudflared,
        args: ['tunnel', '--no-autoupdate', 'run'],
        env: { TUNNEL_TOKEN: secret },
        daemon: true,
        readyPattern: /Registered tunnel connection/,
      },
    ];
  }
  const socket = `--socket=${stateDir}/tailscaled.sock`;
  const tailscale = (name: string, args: string[], extra: Partial<Step> = {}): Step => ({
    name,
    command: BINARIES.tailscale,
    args: [socket, ...args],
    daemon: false,
    ...extra,
  });
  return [
    {
      name: 'tailscaled',
      command: BINARIES.tailscaled,
      args: ['--tun=userspace-networking', `--state=${stateDir}/tailscaled.state`, socket],
      daemon: true,
    },
    tailscale(
      'tailscale up',
      ['up', '--auth-key=file:/dev/stdin', '--hostname=briefroom', '--timeout=60s'],
      { stdin: secret, attempts: LOGIN_ATTEMPTS },
    ),
    // A --bg config outlives tailscaled, so the previous serve or funnel is cleared first.
    tailscale('tailscale serve reset', ['serve', 'reset']),
    tailscale(`tailscale ${mode === 'funnel' ? 'funnel' : 'serve'}`, [
      mode === 'funnel' ? 'funnel' : 'serve',
      '--bg',
      '--https=443',
      `http://127.0.0.1:${port}`,
    ]),
  ];
}

interface Child {
  process: ChildProcessLike;
  daemon: boolean;
  alive: boolean;
  done: Promise<void>;
}

interface Run {
  children: Child[];
  cancels: (() => void)[];
  waitingForReady: number;
  stepsDone: boolean;
  runningAt: number | null;
  failed: boolean;
}

class Cancelled extends Error {}

/** Keeps one tunnel's child processes alive, restarting them with backoff when one dies. */
export class Supervisor {
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly listeners: ((s: SupervisorSnapshot) => void)[] = [];
  private mode: TunnelMode | null = null;
  private secret: string | null = null;
  private status: SupervisorStatus = 'off';
  private lastError: string | null = null;
  private run: Run | null = null;
  private generation = 0;
  private failures = 0;
  private cancelRestart: (() => void) | null = null;
  private lastSent = '';
  private lastLine = '';

  constructor(private readonly options: SupervisorOptions) {
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref();
        return () => clearTimeout(timer);
      });
  }

  snapshot(): SupervisorSnapshot {
    const run = this.run;
    return {
      mode: this.mode,
      status: this.status,
      lastError: this.lastError,
      forwarding: !!run && !run.failed && run.children.some((c) => c.daemon && c.alive),
    };
  }

  subscribe(listener: (s: SupervisorSnapshot) => void): void {
    this.listeners.push(listener);
  }

  start(mode: TunnelMode, secret: string): void {
    const generation = ++this.generation;
    this.cancelRestart?.();
    this.cancelRestart = null;
    this.mode = mode;
    this.secret = secret;
    this.failures = 0;
    this.lastError = null;
    this.status = 'starting';
    const halted = this.halt();
    this.changed();
    void halted.then(() => {
      if (generation === this.generation) this.launch();
    });
  }

  async stop(): Promise<void> {
    this.generation++;
    this.cancelRestart?.();
    this.cancelRestart = null;
    const halted = this.halt();
    this.mode = null;
    this.secret = null;
    this.failures = 0;
    this.status = 'off';
    this.lastError = null;
    this.changed();
    await halted;
  }

  private launch(): void {
    const { mode, secret } = this;
    if (!mode || secret === null) return;
    const steps = planFor(mode, secret, this.options.port, this.options.stateDir);
    const run: Run = {
      children: [],
      cancels: [],
      waitingForReady: steps.filter((s) => s.readyPattern).length,
      stepsDone: false,
      runningAt: null,
      failed: false,
    };
    this.run = run;
    this.lastLine = '';
    this.status = 'starting';
    for (const step of steps.filter((s) => s.daemon)) this.spawnDaemon(run, step);
    this.changed();
    if (run.failed) return;
    void this.runSteps(
      run,
      steps.filter((s) => !s.daemon),
    ).then(
      () => {
        run.stepsDone = true;
        this.markRunningIfReady(run);
      },
      (err: unknown) => {
        if (!(err instanceof Cancelled)) this.fail(run, (err as Error).message);
      },
    );
  }

  private spawnDaemon(run: Run, step: Step): void {
    let readySeen = false;
    const child = this.spawnStep(run, step, (line) => {
      if (!readySeen && step.readyPattern?.test(line)) {
        readySeen = true;
        run.waitingForReady--;
        this.markRunningIfReady(run);
      }
    });
    if (!child) return;
    child.process.on('exit', (code, signal) =>
      this.fail(run, `${step.name} exited with ${describeExit(code, signal)}`),
    );
    child.process.on('error', (err) =>
      this.fail(run, `${step.name} could not start: ${err.message}`),
    );
  }

  private async runSteps(run: Run, steps: Step[]): Promise<void> {
    for (const step of steps) {
      const attempts = step.attempts ?? 1;
      for (let attempt = 1; ; attempt++) {
        const problem = await this.runOnce(run, step);
        if (!this.isCurrent(run)) throw new Cancelled();
        if (problem === null) break;
        if (attempt >= attempts) throw new Error(problem);
        await this.wait(run, STEP_RETRY_MS);
      }
    }
  }

  /** Resolves null when the command succeeded, or the reason it did not. */
  private runOnce(run: Run, step: Step): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      let cancelTimeout = (): void => undefined;
      const settle = (problem: string | null) => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        resolve(problem);
      };
      const child = this.spawnStep(run, step, () => undefined, settle);
      if (!child) return;
      cancelTimeout = this.schedule(() => {
        child.process.kill('SIGKILL');
        settle(`${step.name} did not finish within ${STEP_TIMEOUT_MS / 1000} seconds`);
      }, STEP_TIMEOUT_MS);
      child.process.on('exit', (code, signal) =>
        settle(code === 0 ? null : `${step.name} exited with ${describeExit(code, signal)}`),
      );
      child.process.on('error', (err) => settle(`${step.name} could not start: ${err.message}`));
    });
  }

  private spawnStep(
    run: Run,
    step: Step,
    onLine: (line: string) => void,
    onSpawnFailure: (problem: string) => void = (problem) => this.fail(run, problem),
  ): Child | null {
    let process: ChildProcessLike;
    try {
      process = this.options.spawn(step.command, step.args, {
        env: { ...this.options.env, ...step.env },
        stdio: [step.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      onSpawnFailure(`${step.name} could not start: ${(err as Error).message}`);
      return null;
    }
    const child: Child = {
      process,
      daemon: step.daemon,
      alive: true,
      done: new Promise((resolve) => {
        const gone = () => {
          child.alive = false;
          resolve();
        };
        process.on('exit', gone);
        process.on('error', gone);
      }),
    };
    run.children.push(child);
    const output = (chunk: Buffer | string, buffered: { rest: string }) => {
      const lines = (buffered.rest + String(chunk)).split(/\r?\n/);
      buffered.rest = lines.pop() ?? '';
      for (const raw of lines) {
        const line = this.redact(raw).trim();
        if (!line) continue;
        this.lastLine = line;
        this.options.logger.log(`${step.name}: ${line}`);
        onLine(raw);
      }
    };
    const out = { rest: '' };
    const err = { rest: '' };
    process.stdout?.on('data', (chunk) => output(chunk, out));
    process.stderr?.on('data', (chunk) => output(chunk, err));
    if (step.stdin !== undefined && process.stdin) {
      // A child that exits before reading would make the write fail with EPIPE.
      process.stdin.on('error', () => undefined);
      process.stdin.end(step.stdin);
    }
    return child;
  }

  private markRunningIfReady(run: Run): void {
    if (!this.isCurrent(run) || !run.stepsDone || run.waitingForReady > 0) return;
    run.runningAt = this.now();
    this.status = 'running';
    this.changed();
  }

  private fail(run: Run, problem: string): void {
    if (!this.isCurrent(run)) return;
    run.failed = true;
    this.kill(run);
    if (run.runningAt !== null && this.now() - run.runningAt >= STABLE_RUN_MS) this.failures = 0;
    const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!;
    this.failures++;
    const detail = this.lastLine && !problem.includes(this.lastLine) ? `: ${this.lastLine}` : '';
    this.lastError = this.redact(`${problem}${detail}`).slice(0, MAX_ERROR_LENGTH);
    this.status = 'restarting';
    this.options.logger.warn(`Remote access ${this.lastError}. Restarting in ${delay / 1000}s.`);
    this.changed();
    const generation = this.generation;
    this.cancelRestart = this.schedule(() => {
      this.cancelRestart = null;
      if (generation === this.generation) this.launch();
    }, delay);
  }

  /** Ends the current run and resolves once its children are gone. */
  private halt(): Promise<void> {
    const run = this.run;
    this.run = null;
    if (!run) return Promise.resolve();
    run.failed = true;
    return this.kill(run);
  }

  private kill(run: Run): Promise<void> {
    for (const cancel of run.cancels.splice(0)) cancel();
    return Promise.all(
      run.children
        .filter((c) => c.alive)
        .map((c) => {
          c.process.kill('SIGTERM');
          const cancel = this.schedule(() => c.process.kill('SIGKILL'), STOP_GRACE_MS);
          return c.done.then(cancel);
        }),
    ).then(() => undefined);
  }

  private wait(run: Run, ms: number): Promise<void> {
    return new Promise((resolve) => {
      run.cancels.push(this.schedule(resolve, ms));
    });
  }

  private isCurrent(run: Run): boolean {
    return this.run === run && !run.failed;
  }

  private redact(text: string): string {
    return this.secret ? text.split(this.secret).join(REDACTED) : text;
  }

  private changed(): void {
    const snapshot = this.snapshot();
    const key = JSON.stringify(snapshot);
    if (key === this.lastSent) return;
    this.lastSent = key;
    for (const listener of this.listeners) listener(snapshot);
  }
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`;
}
