import { CLI_LOGIN_CODE } from '@briefroom/contracts';

// People type the code by hand, so case, spaces and a missing dash are forgiven.
export function normalizeCliLoginCode(input: string): string | null {
  const compact = input.replace(/[\s-]/g, '').toUpperCase();
  if (compact.length !== 8) return null;
  const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  return CLI_LOGIN_CODE.test(code) ? code : null;
}
