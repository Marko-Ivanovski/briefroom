import { text, timestamp } from 'drizzle-orm/pg-core';

export type Via = 'web' | 'mcp' | 'cli' | 'system';

export interface Actor {
  userId: string;
  via: Via;
  agent?: string;
}

export function auditColumns() {
  return {
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdVia: text('created_via').$type<Via>().notNull(),
    createdAgent: text('created_agent'),
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedVia: text('updated_via').$type<Via>().notNull(),
    updatedAgent: text('updated_agent'),
  };
}

export interface UpdatedStamp {
  updatedBy: string;
  updatedAt: Date;
  updatedVia: Via;
  updatedAgent: string | null;
}

export interface CreatedStamp extends UpdatedStamp {
  createdBy: string;
  createdAt: Date;
  createdVia: Via;
  createdAgent: string | null;
}

export function updatedStamp(actor: Actor): UpdatedStamp {
  return {
    updatedBy: actor.userId,
    updatedAt: new Date(),
    updatedVia: actor.via,
    updatedAgent: actor.agent ?? null,
  };
}

export function createdStamp(actor: Actor): CreatedStamp {
  const updated = updatedStamp(actor);
  return {
    createdBy: actor.userId,
    createdAt: updated.updatedAt,
    createdVia: actor.via,
    createdAgent: actor.agent ?? null,
    ...updated,
  };
}
