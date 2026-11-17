import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds a program in the absolute PATH entries only. Empty, relative and `.` entries are skipped
 * and the working directory is never searched, so a file planted in a cloned repo is never chosen.
 */
export function resolveCommand(
  name: string,
  env: { PATH?: string | undefined; PATHEXT?: string | undefined },
  platform: NodeJS.Platform,
): string | null {
  const extensions =
    platform === 'win32'
      ? (env.PATHEXT ?? '.EXE')
          .split(';')
          .filter((e) => e !== '')
          .map((e) => e.toLowerCase())
      : [''];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const candidate = join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}
