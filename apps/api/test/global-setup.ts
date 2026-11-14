import { sweepStaleTestDbs } from '@briefroom/db/testing';

export default async function globalSetup(): Promise<void> {
  await sweepStaleTestDbs();
}
