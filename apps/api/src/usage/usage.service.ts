import { scopedInsert, usageEvents, type Db } from '@briefroom/db';
import { Inject, Injectable } from '@nestjs/common';
import type { Scope } from '../access/scope.ts';
import { DB } from '../database/database.module.ts';

export interface UsageEvent {
  tool: string;
  itemType?: string;
  itemId?: string;
  projectId?: string;
}

@Injectable()
export class UsageService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Stores the tool name and ids only. Arguments, prompts and results are never passed in. */
  async log(scope: Scope, e: UsageEvent): Promise<void> {
    await this.db.insert(usageEvents).values(
      scopedInsert(scope, {
        projectId: e.projectId ?? null,
        userId: scope.userId,
        agent: scope.actor.agent ?? 'unknown',
        tool: e.tool,
        itemType: e.itemType ?? null,
        itemId: e.itemId ?? null,
      }),
    );
  }
}
