import { readFileSync } from 'node:fs';

// The image is built from a bundle, where package.json is no longer next to the source, so the
// Dockerfile passes the release version in.
export const APP_VERSION =
  process.env.BRIEFROOM_VERSION ||
  (
    JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;
