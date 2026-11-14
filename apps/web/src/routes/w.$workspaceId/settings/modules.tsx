import { Label } from '@briefroom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import type { ModuleSettingsPanelProps } from '@briefroom/module-kit/web';
import { useState, type ComponentType } from 'react';
import { api } from '../../../api/client.ts';
import { moduleDetailQuery, modulesQuery, workspacesQuery } from '../../../api/queries.ts';
import { FormError } from '../../../components/form-error.tsx';
import { MODULE_CODES, MODULE_ERRORS, messageFor } from '../../../lib/errors.ts';
import { isAdminRole } from '../../../lib/roles.ts';
import { WEB_MODULES } from '../../../modules.ts';

interface PanelHostProps {
  workspaceId: string;
  moduleId: string;
  canEdit: boolean;
  Panel: ComponentType<ModuleSettingsPanelProps>;
}

function SettingsPanelHost({ workspaceId, moduleId, canEdit, Panel }: PanelHostProps) {
  const queryClient = useQueryClient();
  const { data } = useQuery(moduleDetailQuery(workspaceId, moduleId));
  const save = useMutation({
    mutationFn: (settings: Record<string, unknown>) =>
      api.updateModule(workspaceId, moduleId, { settings }),
    onSettled: () => queryClient.invalidateQueries(modulesQuery(workspaceId)),
  });
  if (!data) return null;
  return (
    <>
      <Panel
        workspaceId={workspaceId}
        settings={data.settings}
        canEdit={canEdit}
        save={async (settings) => {
          await save.mutateAsync(settings);
        }}
      />
      <FormError
        message={save.isError ? messageFor(save.error, MODULE_ERRORS, MODULE_CODES) : null}
      />
    </>
  );
}

export const Route = createFileRoute('/w/$workspaceId/settings/modules')({
  loader: async ({ context: { queryClient }, params }) => {
    await Promise.all([
      queryClient.query({ ...modulesQuery(params.workspaceId), staleTime: 0 }),
      queryClient.query({ ...workspacesQuery, staleTime: 'static' }),
    ]);
  },
  component: ModulesPage,
});

function ModulesPage() {
  const { workspaceId } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: modules = [] } = useQuery(modulesQuery(workspaceId));
  const { data: workspaces = [] } = useQuery(workspacesQuery);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const isAdmin = isAdminRole(workspaces.find((w) => w.id === workspaceId)?.role);

  const toggle = useMutation({
    mutationFn: (v: { moduleId: string; enabled: boolean }) =>
      api.updateModule(workspaceId, v.moduleId, { enabled: v.enabled }),
    onSettled: async () => {
      await queryClient.invalidateQueries(modulesQuery(workspaceId));
      setPending({});
    },
  });

  return (
    <section>
      <h1 className="mb-4 text-2xl font-semibold">Modules</h1>
      <FormError
        message={toggle.isError ? messageFor(toggle.error, MODULE_ERRORS, MODULE_CODES) : null}
      />
      <ul className="grid gap-4">
        {modules.map((m) => {
          const Panel = WEB_MODULES.find((w) => w.id === m.id)?.settingsPanel;
          const enabled = pending[m.id] ?? m.enabled;
          return (
            <li key={m.id} className="grid gap-2 rounded-md border p-4">
              <div className="flex items-start gap-3">
                <input
                  id={`module-${m.id}`}
                  type="checkbox"
                  role="switch"
                  className="mt-1 size-4"
                  checked={enabled}
                  disabled={!isAdmin}
                  onChange={(e) => {
                    setPending((current) => ({ ...current, [m.id]: e.target.checked }));
                    toggle.mutate({ moduleId: m.id, enabled: e.target.checked });
                  }}
                />
                <div className="grid gap-0.5">
                  <Label htmlFor={`module-${m.id}`}>{m.name}</Label>
                  <p className="text-muted-foreground text-sm">{m.description}</p>
                </div>
              </div>
              {Panel && m.enabled ? (
                <SettingsPanelHost
                  workspaceId={workspaceId}
                  moduleId={m.id}
                  canEdit={isAdmin}
                  Panel={Panel}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
