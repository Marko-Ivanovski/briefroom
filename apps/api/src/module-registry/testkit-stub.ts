import type { ModuleManifest } from '@briefroom/module-kit';

// The production build aliases the testkit imports here, so none of its code ships. Nothing
// reads these: REGISTERED_MODULES only uses them when BRIEFROOM_TESTKIT=1, which production refuses.
export const testkitManifest = undefined as unknown as ModuleManifest;
export class TestkitModule {}
