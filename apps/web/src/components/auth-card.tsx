import { Card, CardContent, CardHeader, CardTitle } from '@briefroom/ui';
import type { ReactNode, Ref } from 'react';

interface AuthCardProps {
  title: string;
  children: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
}

export function AuthCard({ title, children, headingRef }: AuthCardProps) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center p-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>
            <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="outline-none">
              {title}
            </h1>
          </CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}
