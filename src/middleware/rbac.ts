import { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/errors";

/**
 * Action-based permission check, per BRD 5.2: "Action-based permission
 * matrix: view, create, edit, submit, approve, post, cancel, reopen,
 * import, export, override."
 *
 * Permission strings are of the form "moduleCode.screenCode.actionCode"
 * and are embedded in the JWT at login (see modules/auth). Tenant Admin and
 * Super Admin roles bypass the check, matching the "full access" role
 * definitions in BRD section 8.
 */
export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return next(ApiError.unauthorized());

    if (user.roles.includes("SuperAdmin") || user.roles.includes("TenantAdmin")) {
      return next();
    }

    if (user.permissions.includes(permission) || user.permissions.includes("*")) {
      return next();
    }

    return next(ApiError.forbidden(`Missing permission: ${permission}`));
  };
}

/** Restricts a route to one or more role codes (e.g. SuperAdmin-only SaaS routes). */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return next(ApiError.unauthorized());
    if (roles.some((r) => user.roles.includes(r))) return next();
    return next(ApiError.forbidden(`Requires role: ${roles.join(" or ")}`));
  };
}

/**
 * Same rule as requirePermission() above, but as a plain boolean check
 * instead of middleware - for call sites that need to branch on
 * "can this requester see X" mid-handler (e.g. field-level masking)
 * rather than reject the whole request.
 */
export function hasPermission(req: Request, permission: string): boolean {
  const user = req.user;
  if (!user) return false;
  if (user.roles.includes("SuperAdmin") || user.roles.includes("TenantAdmin")) return true;
  return user.permissions.includes(permission) || user.permissions.includes("*");
}
