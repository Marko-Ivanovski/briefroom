import type { AnyRoute } from '@tanstack/react-router';
import type { ComponentType } from 'react';

export interface ModuleSettingsPanelProps {
  workspaceId: string;
  settings: Record<string, unknown>;
  /** True only for admins. The server refuses a save from anyone else. */
  canEdit: boolean;
  save(settings: Record<string, unknown>): Promise<void>;
}

export interface ModuleWebEntry {
  id: string;
  routes: AnyRoute[];
  nav: { label: string; to: string }[];
  settingsPanel?: ComponentType<ModuleSettingsPanelProps>;
}
