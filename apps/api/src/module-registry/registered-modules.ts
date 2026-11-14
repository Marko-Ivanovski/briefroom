import type { Type } from '@nestjs/common';
import type { ModuleManifest } from '@briefroom/module-kit';
import { testkitManifest } from '@briefroom/module-testkit/manifest';
import { TestkitModule } from '@briefroom/module-testkit/server';

export interface RegisteredModule {
  manifest: ModuleManifest;
  nestModule: Type;
}

/** The only place the API imports modules from. */
export const REGISTERED_MODULES: RegisteredModule[] = [
  ...(process.env.BRIEFROOM_TESTKIT === '1'
    ? [{ manifest: testkitManifest, nestModule: TestkitModule }]
    : []),
];
