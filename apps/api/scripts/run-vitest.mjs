import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// On Windows, Node 24 intermittently kills a test worker with exit 3221226505 (0xC0000409) around
// Postgres socket teardown. Vitest then drops that file's results. This reruns only the files
// whose worker died. A file with a failing test is never retried.
const MAX_RERUNS = 2;
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const crashPattern =
  /Worker exited unexpectedly with exit code (\d+) during \w+ state while running test files? ([^\n]+)/g;

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
    child.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), output }));
  });
}

function crashedFiles(output) {
  const files = new Set();
  for (const match of output.matchAll(crashPattern)) {
    for (const file of match[2].split(',')) files.add(file.trim());
  }
  return [...files];
}

function hasFailedTests(output) {
  return /^\s*FAIL\s/m.test(output);
}

let args = process.argv.slice(2);
let result = await runVitest(args);

for (let rerun = 1; result.code !== 0 && rerun <= MAX_RERUNS; rerun++) {
  const files = crashedFiles(result.output);
  if (files.length === 0 || hasFailedTests(result.output)) break;
  process.stderr.write(
    `\n[run-vitest] worker crashed in ${files.length} file(s), rerun ${rerun}/${MAX_RERUNS}: ${files.join(', ')}\n\n`,
  );
  args = files;
  result = await runVitest(args);
}

process.exit(result.code);
