import { SetMetadata } from '@nestjs/common';
import type { AdminRole } from '../../admin/admin-auth';

export const ADMIN_ROLE_KEY = 'admin_role';

/** Declares the minimum admin role required for a handler (defaults to read). */
export const RequireAdminRole = (role: AdminRole) =>
  SetMetadata(ADMIN_ROLE_KEY, role);
