import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '@briefroom/db/testing';
import { TESTKIT_SQL_PATH } from '@briefroom/module-testkit/sql';

const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
const WEB_DIST = fileURLToPath(new URL('../dist', import.meta.url));
const BOOT_TIMEOUT_MS = 60_000;
const SETUP_CODE = /setup code:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not reserve a port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
}

// The API logs the one-time setup code at boot. Reading it from stdout is the only way tests get it.
function readSetupCode(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error(`API printed no setup code within boot timeout. Output:\n${output}`)),
      BOOT_TIMEOUT_MS,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = SETUP_CODE.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`API exited with code ${code} before boot finished. Output:\n${output}`));
    });
  });
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('API did not become healthy in time');
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // The e2e run always has the testkit on, and its table never enters the migrations.
  const testDb = await createTestDb({ extraSqlFiles: [TESTKIT_SQL_PATH] });
  let api: ChildProcess | undefined;
  const teardown = async () => {
    if (api) await stop(api);
    await testDb.close();
  };

  try {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    api = spawn(process.execPath, ['--import', '@swc-node/register/esm-register', 'src/main.ts'], {
      cwd: API_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        BRIEFROOM_TESTKIT: '1',
        DATABASE_URL: testDb.url,
        PORT: String(port),
        HOST: '127.0.0.1',
        BRIEFROOM_PUBLIC_URL: baseUrl,
        BRIEFROOM_WEB_DIR: WEB_DIST,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const code = await readSetupCode(api);
    await waitForHealth(baseUrl);
    process.env.E2E_BASE_URL = baseUrl;
    process.env.E2E_SETUP_CODE = code;
  } catch (err) {
    await teardown();
    throw err;
  }
  return teardown;
}
