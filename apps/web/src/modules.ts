import type { ModuleWebEntry } from '@briefroom/module-kit/web';

// The testkit is test-only. The flag is replaced at build time, so the dead branch and its
// import are dropped from any bundle built without it.
const testkit: ModuleWebEntry[] =
  import.meta.env.VITE_BRIEFROOM_TESTKIT === '1'
    ? [(await import('@briefroom/module-testkit/web')).testkitWeb]
    : [];

/** The only place the web app imports modules from. */
export const WEB_MODULES: ModuleWebEntry[] = [...testkit];
