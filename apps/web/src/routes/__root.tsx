import { cn } from '@briefroom/ui';
import { createRootRoute, Outlet } from '@tanstack/react-router';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className={cn('min-h-screen bg-white text-neutral-900')}>
      <Outlet />
    </div>
  );
}
