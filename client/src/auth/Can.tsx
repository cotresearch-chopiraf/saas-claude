import type { ReactNode } from "react";
import { useAuth } from "./AuthContext";
import { hasPermission, type PermissionAction } from "./permissions";

// UI visibility only — see permissions.ts. The backend remains the sole
// authorization authority; this never replaces a server-side check.
export function Can({ permission, children }: { permission: PermissionAction; children: ReactNode }) {
  const { user } = useAuth();
  if (!hasPermission(user?.role, permission)) return null;
  return <>{children}</>;
}
