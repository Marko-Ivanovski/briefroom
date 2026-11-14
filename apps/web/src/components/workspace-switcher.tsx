import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@briefroom/ui';
import type { WorkspaceSummary } from '@briefroom/contracts';
import { Link } from '@tanstack/react-router';
import { ChevronsUpDown } from 'lucide-react';

interface WorkspaceSwitcherProps {
  workspaces: WorkspaceSummary[];
  currentId: string;
  isInstallOwner: boolean;
}

export function WorkspaceSwitcher({
  workspaces,
  currentId,
  isInstallOwner,
}: WorkspaceSwitcherProps) {
  const current = workspaces.find((w) => w.id === currentId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          {current?.name ?? 'Workspace'}
          <ChevronsUpDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaces.map((w) => (
          <DropdownMenuItem key={w.id} asChild>
            <Link to="/w/$workspaceId" params={{ workspaceId: w.id }}>
              {w.name}
            </Link>
          </DropdownMenuItem>
        ))}
        {isInstallOwner && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/w/$workspaceId/new-workspace" params={{ workspaceId: currentId }}>
                New workspace
              </Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
