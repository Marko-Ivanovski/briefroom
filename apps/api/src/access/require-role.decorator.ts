import { SetMetadata } from '@nestjs/common';
import type { Role } from './scope.ts';

export const REQUIRED_ROLE = 'briefroom:required-role';

export const RequireRole = (min: Role) => SetMetadata(REQUIRED_ROLE, min);
