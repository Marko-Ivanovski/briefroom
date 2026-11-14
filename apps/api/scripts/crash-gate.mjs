// Windows status 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN), the only crash worth retrying.
const KNOWN_CRASH_CODE = '3221226505';
const crashPattern =
  /Worker exited unexpectedly with exit code (\d+) during \w+ state while running test files? ([^\n]+)/g;

/**
 * Returns the crashed test files when every failure in the run is a known worker crash,
 * otherwise null. Never approves a run that has any other failure.
 */
export function retryableCrashes(output) {
  const crashes = [...output.matchAll(crashPattern)];
  if (crashes.length === 0) return null;
  if (crashes.some((c) => c[1] !== KNOWN_CRASH_CODE)) return null;
  if (/^\s*FAIL\s/m.test(output)) return null;
  if (/^\s*(Test Files|Tests)\s.*\bfailed\b/m.test(output)) return null;
  const errors = output.match(/^\s*Errors\s+(\d+) errors?/m);
  if (!errors || Number(errors[1]) !== crashes.length) return null;
  return [...new Set(crashes.flatMap((c) => c[2].split(',').map((f) => f.trim())))];
}
