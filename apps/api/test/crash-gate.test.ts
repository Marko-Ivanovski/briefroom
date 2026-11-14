import { describe, expect, it } from 'vitest';
import { retryableCrashes } from '../../../scripts/crash-gate.mjs';

const CODE = 3221226505;
const crash = (file: string, code = CODE) =>
  `Caused by: Error: Worker exited unexpectedly with exit code ${code} during started state while running test file ${file}\n`;
const errors = (n: number) =>
  ` Test Files  16 passed (17)\n      Tests  270 passed (298)\n     Errors  ${n} error${n > 1 ? 's' : ''}\n`;

describe('retryableCrashes', () => {
  it('returns the crashed files when the only failure is the known worker crash', () => {
    expect(retryableCrashes(crash('/a/x.test.ts') + errors(1))).toEqual(['/a/x.test.ts']);
  });

  it('handles several crashes when every error is a crash', () => {
    const out = crash('/a/x.test.ts') + crash('/a/y.test.ts') + errors(2);
    expect(retryableCrashes(out)).toEqual(['/a/x.test.ts', '/a/y.test.ts']);
  });

  it('refuses when a test failed', () => {
    const out = ` FAIL  test/z.test.ts > a > b\n${crash('/a/x.test.ts')}${errors(1)}`;
    expect(retryableCrashes(out)).toBeNull();
  });

  it('refuses when the summary reports failed tests or files', () => {
    const out = `${crash('/a/x.test.ts')} Test Files  1 failed | 15 passed (17)\n     Errors  1 error\n`;
    expect(retryableCrashes(out)).toBeNull();
  });

  it('refuses when there are more unhandled errors than crashes', () => {
    expect(retryableCrashes(crash('/a/x.test.ts') + errors(2))).toBeNull();
  });

  it('refuses when the error summary is missing', () => {
    expect(retryableCrashes(crash('/a/x.test.ts'))).toBeNull();
  });

  it('refuses any exit code other than 0xC0000409', () => {
    expect(retryableCrashes(crash('/a/x.test.ts', 137) + errors(1))).toBeNull();
    expect(retryableCrashes(crash('/a/x.test.ts', 1) + errors(1))).toBeNull();
  });

  it('refuses when there is no crash at all', () => {
    expect(retryableCrashes(errors(1))).toBeNull();
  });
});
