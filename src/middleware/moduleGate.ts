import { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { ApiError } from "../utils/errors";
import { asyncHandler } from "../utils/asyncHandler";

/**
 * Tenant-level module entitlement gate - a separate axis from
 * requirePermission (rbac.ts), which controls who *within* a tenant can do
 * what. This controls whether the tenant's own subscription/setup even
 * includes this module at all, regardless of the calling user's own
 * permissions - this is the mechanism behind "enable/disable modules per
 * client" (Procurement, Inventory, Recipe, ...): mount it once per module's
 * router with router.use(requireModule("Procurement")) and every route in
 * that file is covered.
 *
 * Super Admin bypasses this (same convention as requirePermission/requireRole
 * in rbac.ts) so platform staff can always reach every module for support and
 * diagnostics, even on a tenant that hasn't had it turned on yet.
 *
 * No TenantModule row for a given tenant+module means the module has never
 * been explicitly turned on for that tenant - this fails CLOSED (disabled)
 * rather than open, so a freshly onboarded tenant starts with nothing until
 * modules are deliberately enabled (via /saas/tenant-modules), matching the
 * whole point of per-client module control: nothing is on by accident.
 */
export function requireModule(moduleCode: string) {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.roles.includes("SuperAdmin")) return next();

    const tenantId = req.tenant!.id;
    const tm = await prisma.tenantModule.findUnique({
      where: { tenantId_moduleCode: { tenantId, moduleCode } },
    });
    if (!tm?.enabled) {
      throw ApiError.forbidden(`The ${moduleCode} module is not enabled for this account.`);
    }
    next();
  });
}
