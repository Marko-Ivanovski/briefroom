import { ON_JOB } from '@briefroom/module-kit';
import { REGISTERED_MODULES } from '@briefroom/api/worker-kit';
import { Injectable, type Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import 'reflect-metadata';
import { CoreServicesModule } from './core-services.module.ts';

export interface DiscoveredHandler {
  /** `<moduleId>.<name>` or `core.<name>`. */
  name: string;
  /** The owning module, or null for a core handler. */
  moduleId: string | null;
  invoke(context: object): Promise<unknown>;
}

interface ModuleRef {
  manifest: { id: string };
  nestModule: Type;
}

type ImportEntry = Type | { module: Type; imports?: unknown[] } | { forwardRef: () => Type };

function methodsOf(instance: object): string[] {
  const names = new Set<string>();
  for (
    let proto: object | null = Object.getPrototypeOf(instance);
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (
        key !== 'constructor' &&
        typeof Object.getOwnPropertyDescriptor(proto, key)?.value === 'function'
      ) {
        names.add(key);
      }
    }
  }
  return [...names];
}

/** Maps each Nest module in a registered module's import graph, dynamic modules included, to its id. */
function ownersOf(registered: readonly ModuleRef[]): Map<unknown, string> {
  const owners = new Map<unknown, string>();
  for (const { manifest, nestModule } of registered) {
    const walk = (entry: unknown): void => {
      let cls: Type | undefined;
      let extra: unknown[] = [];
      const e = entry as ImportEntry;
      if (typeof e === 'function') cls = e;
      else if (e && 'module' in e) {
        cls = e.module;
        extra = e.imports ?? [];
      } else if (e && 'forwardRef' in e) cls = e.forwardRef();
      if (!cls || owners.has(cls)) return;
      owners.set(cls, manifest.id);
      const own = (Reflect.getMetadata('imports', cls) as unknown[] | undefined) ?? [];
      for (const next of [...own, ...extra]) walk(next);
    };
    walk(nestModule);
  }
  return owners;
}

/** Finds every `@OnJob` method on the providers this process loaded. */
@Injectable()
export class HandlersExplorer {
  constructor(private readonly discovery: DiscoveryService) {}

  explore(registered: readonly ModuleRef[] = REGISTERED_MODULES): DiscoveredHandler[] {
    const owners = ownersOf(registered);
    const found = new Map<string, DiscoveredHandler>();
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (typeof instance !== 'object' || instance === null) continue;
      const host: unknown = wrapper.host?.metatype;
      const moduleId = host === CoreServicesModule ? null : owners.get(host);
      for (const method of methodsOf(instance)) {
        const fn = (instance as Record<string, unknown>)[method] as (c: object) => Promise<unknown>;
        const name = Reflect.getMetadata(ON_JOB, fn) as string | undefined;
        if (name === undefined) continue;

        if (moduleId === undefined) {
          throw new Error(
            `Job handler "${name}" is not part of the core or a registered module, so it cannot run`,
          );
        }
        // A module can only handle its own jobs, so one module cannot answer another's queue.
        const prefix = moduleId === null ? 'core.' : `${moduleId}.`;
        if (!name.startsWith(prefix)) {
          const owner = moduleId === null ? 'core code' : `module "${moduleId}"`;
          throw new Error(`Job handler "${name}" is in ${owner}, so it must be named "${prefix}*"`);
        }
        if (found.has(name)) throw new Error(`Two handlers claim the job "${name}"`);
        found.set(name, { name, moduleId, invoke: (context) => fn.call(instance, context) });
      }
    }
    return [...found.values()];
  }
}
