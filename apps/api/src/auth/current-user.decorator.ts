import { createParamDecorator, UnauthorizedException, type ExecutionContext } from '@nestjs/common';

export interface CurrentUserData {
  id: string;
  name: string;
  email: string;
}

interface SessionCarrier {
  session?: { user?: { id: string; name: string; email: string } } | null;
}

export function userFromRequest(request: SessionCarrier): CurrentUserData {
  const user = request.session?.user;
  if (!user) throw new UnauthorizedException();
  return { id: user.id, name: user.name, email: user.email };
}

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  userFromRequest(context.switchToHttp().getRequest<SessionCarrier>()),
);
