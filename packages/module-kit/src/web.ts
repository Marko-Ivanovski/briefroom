import type { AnyRoute } from '@tanstack/react-router';
import type { ComponentType } from 'react';

export interface ModuleWebEntry {
  id: string;
  routes: AnyRoute[];
  nav: { label: string; to: string }[];
  settingsPanel?: ComponentType;
}
