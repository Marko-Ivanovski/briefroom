import { sweepStaleTestDbs } from '../src/testing.ts';

export default async function globalSetup(): Promise<void> {
  await sweepStaleTestDbs();
}
