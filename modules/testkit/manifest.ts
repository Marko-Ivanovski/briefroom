import { defineModule } from '@briefroom/module-kit';
import { z } from 'zod';
import { testkitNotes } from './schema/notes.ts';

export const testkitManifest = defineModule({
  id: 'testkit',
  name: 'Testkit',
  version: '0.0.0',
  description: 'Internal module that proves the module contract. Never part of a release.',
  permissions: [
    { key: 'write-notes', label: 'Write notes', description: 'Create notes in the testkit.' },
  ],
  contentLevels: ['workspace', 'project'],
  tables: [testkitNotes],
  historyTables: ['testkit_notes'],
  settings: z.object({ greeting: z.string().max(40).default('hello') }),
});
