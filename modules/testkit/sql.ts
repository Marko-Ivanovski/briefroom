import { fileURLToPath } from 'node:url';

/** The testkit's own DDL. Only test helpers apply it. */
export const TESTKIT_SQL_PATH = fileURLToPath(new URL('./testkit.sql', import.meta.url));
