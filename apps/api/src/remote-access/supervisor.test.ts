import { beforeEach, describe, expect, it } from 'vitest';
import { fakeSpawn, flush, type SpawnCall } from '../../test/fake-child.ts';
import { Supervisor } from './supervisor.ts';

const TOKEN = 'eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=';
const TS_KEY = 'tskey-auth-kFAKE1CNTRL-abcdefghijklmnop';

interface Pending {
  ms: number;
  fn: () => void;
  cancelled: boolean;
}

function harness(onSpawn?: (call: SpawnCall) => void) {
  const spawned = fakeSpawn(onSpawn);
  const pending: Pending[] = [];
  const logs: string[] = [];
  let clock = 0;
  const supervisor = new Supervisor({
    spawn: spawned.spawn,
    tunnelSocket: '/run/briefroom/tunnel.sock',
    stateDir: '/data/tailscale',
    env: { PATH: '/usr/bin', HOME: '/home/node' },
    now: () => clock,
    schedule: (fn, ms) => {
      const entry = { ms, fn, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  const live = () => pending.filter((p) => !p.cancelled);
  const fire = async () => {
    const next = live()[0];
    expect(next, 'a scheduled restart').toBeDefined();
    next!.cancelled = true;
    next!.fn();
    await flush();
  };
  return {
    ...spawned,
    supervisor,
    logs,
    live,
    fire,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('supervisor with cloudflare', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it('runs cloudflared with the token in its environment, never on the command line', async () => {
    h.supervisor.start('cloudflare', TOKEN);
    await flush();
    const call = h.last();
    expect(call.command).toBe('/usr/local/bin/cloudflared');
    expect(call.args).toEqual(['tunnel', '--no-autoupdate', 'run']);
    expect(call.options.env.TUNNEL_TOKEN).toBe(TOKEN);
    expect(call.args.join(' ')).not.toContain(TOKEN);
  });

  it('passes the child only the environment it was given', async () => {
    process.env.BRIEFROOM_SUPERVISOR_LEAK_CHECK = 'leak';
    try {
      h.supervisor.start('cloudflare', TOKEN);
      await flush();
      expect(h.last().options.env).toEqual({
        PATH: '/usr/bin',
        HOME: '/home/node',
        TUNNEL_TOKEN: TOKEN,
      });
    } finally {
      delete process.env.BRIEFROOM_SUPERVISOR_LEAK_CHECK;
    }
  });

  it('reports starting, then running once the tunnel registers', async () => {
    h.supervisor.start('cloudflare', TOKEN);
    await flush();
    expect(h.supervisor.snapshot()).toMatchObject({ mode: 'cloudflare', status: 'starting' });
    h.last().child.say('2026-11-17T18:56:10Z INF Registered tunnel connection connIndex=0');
    await flush();
    expect(h.supervisor.snapshot()).toMatchObject({ status: 'running', forwarding: true });
  });

  it('restarts a crashed child with backoff 1, 2, 4 ... up to 60 seconds and reports restarting', async () => {
    h.supervisor.start('cloudflare', TOKEN);
    await flush();
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      h.last().child.exit(1);
      await flush();
      expect(h.supervisor.snapshot()).toMatchObject({ status: 'restarting', forwarding: false });
      expect(h.supervisor.snapshot().lastError).toMatch(/cloudflared exited with code 1/);
      delays.push(h.live()[0]!.ms);
      await h.fire();
      expect(h.supervisor.snapshot().status).toBe('starting');
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(h.calls).toHaveLength(10);
  });

  it('starts the backoff over after a stable run', async () => {
    h.supervisor.start('cloudflare', TOKEN);
    await flush();
    h.last().child.exit(1);
    await flush();
    await h.fire();
    h.last().child.exit(1);
    await flush();
    expect(h.live()[0]!.ms).toBe(2000);
    await h.fire();
    h.last().child.say('INF Registered tunnel connection connIndex=0');
    await flush();
    h.advance(10 * 60_000);
    h.last().child.exit(1);
    await flush();
    expect(h.live()[0]!.ms).toBe(1000);
  });

  it('restarts after a spawn error such as a missing binary', async () => {
    h.supervisor.start('cloudflare', TOKEN);
    await flush();
    h.last().child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await flush();
    expect(h.supervisor.snapshot()).toMatchObject({ status: 'restarting' });
    expect(h.supervisor.snapshot().lastError).toMatch(/ENOENT/);
  });

  it('keeps the secret out of logs and last_error', async () => {
    h.supervisor.start('cloudflare', TOKEN);
    await flush();
    h.last().child.say(`INF using token ${TOKEN}`);
    h.last().child.complain(`ERR bad token ${TOKEN}`);
    h.last().child.exit(1);
    await flush();
    expect(h.logs.join('\n')).not.toContain(TOKEN);
    expect(h.logs.join('\n')).toContain('[redacted]');
    expect(h.supervisor.snapshot().lastError).not.toContain(TOKEN);
    expect(h.supervisor.snapshot().lastError).toContain('ERR bad token [redacted]');
  });

  it('keeps redacting what an old run prints after stop() and after a switch (I2)', async () => {
    // Children that keep running through their SIGTERM grace, as real ones may.
    const stubborn = (call: SpawnCall) => {
      call.child.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
        call.child.signals.push(signal);
        return true;
      };
    };
    h = harness(stubborn);
    h.supervisor.start('cloudflare', TOKEN);
    await flush();
    const first = h.last().child;
    h.supervisor.start('cloudflare', 'second-token-value');
    await flush();
    // The old child is still alive, so the new run waits for it. It prints its secret meanwhile.
    first.say(`late line ${TOKEN}`);
    first.complain(`late error ${TOKEN}`);
    first.exit(0);
    await flush();
    const second = h.last().child;
    expect(second).not.toBe(first);
    const stopping = h.supervisor.stop();
    await flush();
    second.say('after stop second-token-value');
    second.exit(0);
    await stopping;
    const logs = h.logs.join('\n');
    expect(logs).toContain('late line [redacted]');
    expect(logs).toContain('after stop [redacted]');
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain('second-token-value');
    expect(h.supervisor.snapshot().lastError).toBeNull();
  });

  it('stops: sends SIGTERM, schedules no restart and reports off', async () => {
    h.supervisor.start('cloudflare', TOKEN);
    await flush();
    const child = h.last().child;
    await h.supervisor.stop();
    expect(child.signals).toEqual(['SIGTERM']);
    expect(h.live()).toHaveLength(0);
    expect(h.supervisor.snapshot()).toEqual({
      mode: null,
      status: 'off',
      lastError: null,
      forwarding: false,
    });
    expect(h.calls).toHaveLength(1);
  });

  it('replaces a running tunnel when started again', async () => {
    h.supervisor.start('cloudflare', TOKEN);
    await flush();
    const first = h.last().child;
    h.supervisor.start('cloudflare', 'another-token');
    await flush();
    await flush();
    expect(first.signals).toEqual(['SIGTERM']);
    expect(h.last().options.env.TUNNEL_TOKEN).toBe('another-token');
    expect(h.supervisor.snapshot().status).toBe('starting');
  });

  it('tells subscribers about every change', async () => {
    const seen: string[] = [];
    h.supervisor.subscribe((s) => seen.push(s.status));
    h.supervisor.start('cloudflare', TOKEN);
    await flush();
    h.last().child.say('INF Registered tunnel connection');
    h.last().child.exit(2);
    await flush();
    expect(seen.filter((s, i) => s !== seen[i - 1])).toEqual(['starting', 'running', 'restarting']);
  });
});

describe('supervisor with tailscale', () => {
  const ok = (call: SpawnCall) => {
    if (call.command.endsWith('/tailscale')) queueMicrotask(() => call.child.exit(0));
  };

  it.each([
    ['tailscale', 'serve'],
    ['funnel', 'funnel'],
  ] as const)('runs tailscaled in userspace mode, logs in, then %s on 443', async (mode, verb) => {
    const h = harness(ok);
    h.supervisor.start(mode, TS_KEY);
    for (let i = 0; i < 6; i++) await flush();
    const sock = '--socket=/data/tailscale/tailscaled.sock';
    expect(h.calls.map((c) => [c.command, ...c.args])).toEqual([
      [
        '/usr/local/bin/tailscaled',
        '--tun=userspace-networking',
        '--state=/data/tailscale/tailscaled.state',
        sock,
      ],
      [
        '/usr/local/bin/tailscale',
        sock,
        'up',
        '--auth-key=file:/dev/stdin',
        '--hostname=briefroom',
        '--timeout=60s',
      ],
      ['/usr/local/bin/tailscale', sock, 'serve', 'reset'],
      [
        '/usr/local/bin/tailscale',
        sock,
        verb,
        '--bg',
        '--https=443',
        'unix:/run/briefroom/tunnel.sock',
      ],
    ]);
    expect(h.calls[1]!.child.stdinText).toBe(TS_KEY);
    for (const call of h.calls) {
      expect(call.args.join(' ')).not.toContain(TS_KEY);
      expect(JSON.stringify(call.options.env)).not.toContain(TS_KEY);
    }
    expect(h.supervisor.snapshot()).toMatchObject({ mode, status: 'running', forwarding: true });
  });

  it('retries the login while tailscaled is still starting', async () => {
    let ups = 0;
    const h = harness((call) => {
      if (!call.command.endsWith('/tailscale')) return;
      const first = call.args.includes('up') && ups++ === 0;
      queueMicrotask(() => call.child.exit(first ? 1 : 0));
    });
    h.supervisor.start('tailscale', TS_KEY);
    for (let i = 0; i < 4; i++) await flush();
    expect(h.supervisor.snapshot().status).toBe('starting');
    expect(h.live()[0]!.ms).toBe(1000);
    await h.fire();
    for (let i = 0; i < 4; i++) await flush();
    expect(h.supervisor.snapshot().status).toBe('running');
    expect(h.calls.filter((c) => c.command.endsWith('tailscaled'))).toHaveLength(1);
  });

  it('restarts everything with backoff when tailscaled dies', async () => {
    const h = harness(ok);
    h.supervisor.start('tailscale', TS_KEY);
    for (let i = 0; i < 6; i++) await flush();
    h.calls[0]!.child.exit(1);
    await flush();
    expect(h.supervisor.snapshot()).toMatchObject({ status: 'restarting', forwarding: false });
    expect(h.live()[0]!.ms).toBe(1000);
    await h.fire();
    expect(h.calls.filter((c) => c.command === '/usr/local/bin/tailscaled')).toHaveLength(2);
    expect(h.calls[0]!.child.signals).toEqual([]);
  });
});
