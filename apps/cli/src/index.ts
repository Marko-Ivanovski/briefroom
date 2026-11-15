import { run } from './cli.ts';
import { defaultContext } from './context.ts';

process.exitCode = await run(process.argv.slice(2), defaultContext());
