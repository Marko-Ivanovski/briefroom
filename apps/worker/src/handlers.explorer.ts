import { ON_JOB } from '@briefroom/module-kit';
import { REGISTERED_MODULES } from '@briefroom/api/worker-kit';
import { Injectable } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import 'reflect-metadata';

export interface DiscoveredHandler {
  /** `<moduleId>.<name>` or `core.<name>`. */
  name: string;
  /** The owning module, or null for a core handler. */
  moduleId: string | null;
  invoke(context: object): Promise<unknown>;
}

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

/** Finds every `@OnJob` method on the providers this process loaded. */
@Injectable()
export class HandlersExplorer {
  constructor(private readonly discovery: DiscoveryService) {}

  explore(): DiscoveredHandler[] {
    const moduleIds = new Map<unknown, string>(
      REGISTERED_MODULES.map((m) => [m.nestModule, m.manifest.id]),
    );
    const found = new Map<string, DiscoveredHandler>();
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (typeof instance !== 'object' || instance === null) continue;
      const moduleId = moduleIds.get(wrapper.host?.metatype) ?? null;
      for (const method of methodsOf(instance)) {
        const fn = (instance as Record<string, unknown>)[method] as (c: object) => Promise<unknown>;
        const name = Reflect.getMetadata(ON_JOB, fn) as string | undefined;
        if (name === undefined) continue;

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
