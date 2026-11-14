import { Injectable } from '@nestjs/common';
import { REGISTERED_MODULES, type RegisteredModule } from './registered-modules.ts';

@Injectable()
export class ModuleRegistryService {
  private readonly byId = new Map<string, RegisteredModule>();

  constructor() {
    for (const m of REGISTERED_MODULES) {
      if (this.byId.has(m.manifest.id)) throw new Error(`Duplicate module id "${m.manifest.id}"`);
      this.byId.set(m.manifest.id, m);
    }
  }

  list(): RegisteredModule[] {
    return [...this.byId.values()];
  }

  get(id: string): RegisteredModule | undefined {
    return this.byId.get(id);
  }
}
