import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { retryableCrashes } from './crash-gate.mjs';

// On Windows, Node 24 intermittently kills a test worker with exit 3221226505 (0xC0000409) around
// Postgres socket teardown. Vitest then drops that file's results. On Windows only, this reruns
// the crashed files when that crash is the run's only failure. Elsewhere a crashed worker fails
// the run.
const MAX_RERUNS = 2;
const vitest = join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs');

function runVitest(args) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(process.execPath, [vitest, 'run', ...args], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    for (const [stream, sink] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on('data', (chunk) => {
        output += chunk;
        sink.write(chunk);
      });
    }
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), output }));
  });
}

const userArgs = process.argv.slice(2);
let result = await runVitest(userArgs);

for (
  let rerun = 1;
  process.platform === 'win32' && result.code !== 0 && rerun <= MAX_RERUNS;
  rerun++
) {
  const files = retryableCrashes(result.output);
  if (!files) break;
  for (const file of files) {
    process.stderr.write(
      `\n[run-vitest] worker crashed with exit code 3221226505 in ${file}, rerun ${rerun}/${MAX_RERUNS}\n`,
    );
  }
  result = await runVitest([...userArgs, ...files]);
}

process.exit(result.code);
