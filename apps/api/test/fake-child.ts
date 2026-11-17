import { EventEmitter } from 'node:events';
import type {
  ChildProcessLike,
  SpawnChild,
  SpawnOptions,
} from '../src/remote-access/supervisor.ts';

/** A child process that does nothing until the test says so. */
export class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];
  stdinText = '';
  exited = false;
  readonly stdin = {
    on: () => this.stdin,
    end: (chunk: string) => {
      this.stdinText += chunk;
    },
  };

  say(line: string): void {
    this.stdout.emit('data', Buffer.from(`${line}\n`));
  }

  complain(line: string): void {
    this.stderr.emit('data', Buffer.from(`${line}\n`));
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    queueMicrotask(() => this.exit(null, signal));
    return true;
  }
}

export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  child: FakeChild;
}

/** Records every spawn. `onSpawn` lets a test script a child, for example to exit at once. */
export function fakeSpawn(onSpawn: (call: SpawnCall) => void = () => undefined) {
  const calls: SpawnCall[] = [];
  const spawn: SpawnChild = (command, args, options) => {
    const call = { command, args, options, child: new FakeChild() };
    calls.push(call);
    onSpawn(call);
    return call.child;
  };
  return { spawn, calls, last: () => calls[calls.length - 1]! };
}

/** Lets a tunnel come up the way the real binaries would: daemons stay, one-shot commands succeed. */
export function healthyTunnels(call: SpawnCall): void {
  if (call.command.endsWith('cloudflared')) {
    queueMicrotask(() => call.child.say('INF Registered tunnel connection connIndex=0'));
  } else if (call.command.endsWith('/tailscale')) {
    queueMicrotask(() => call.child.exit(0));
  }
}

export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
