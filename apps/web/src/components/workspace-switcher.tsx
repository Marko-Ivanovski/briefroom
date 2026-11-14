import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@briefroom/ui';
import type { BookmarkSummary, WorkspaceSummary } from '@briefroom/contracts';
import { Link } from '@tanstack/react-router';
import { ChevronsUpDown } from 'lucide-react';
import { safeHttpUrl } from '../lib/safe-url.ts';

interface WorkspaceSwitcherProps {
  workspaces: WorkspaceSummary[];
  currentId: string;
  isInstallOwner: boolean;
  bookmarks: BookmarkSummary[];
  onJoin: () => void;
  onRemoveBookmark: (id: string) => void;
}

export function WorkspaceSwitcher({
  workspaces,
  currentId,
  isInstallOwner,
  bookmarks,
  onJoin,
  onRemoveBookmark,
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
        {bookmarks.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Bookmarks</DropdownMenuLabel>
            {bookmarks.map((b) => {
              const href = safeHttpUrl(b.remoteBaseUrl);
              return (
                <div key={b.id} className="flex items-center">
                  {href ? (
                    <DropdownMenuItem asChild className="flex-1">
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {b.label}
                      </a>
                    </DropdownMenuItem>
                  ) : (
                    <span className="flex-1 px-2 py-1.5 text-sm">{b.label}</span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove bookmark ${b.label}`}
                    onClick={() => onRemoveBookmark(b.id)}
                  >
                    Remove
                  </Button>
                </div>
              );
            })}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onJoin}>Join a workspace</DropdownMenuItem>
        {isInstallOwner && (
          <DropdownMenuItem asChild>
            <Link to="/w/$workspaceId/new-workspace" params={{ workspaceId: currentId }}>
              New workspace
            </Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
