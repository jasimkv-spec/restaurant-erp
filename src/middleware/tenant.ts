import { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { ApiError } from "../utils/errors";

/**
 * Resolves the tenant for every request BEFORE any business query runs, per
 * the ERD blueprint's tenant isolation strategy (section 11):
 *   "Application middleware must resolve tenant from subdomain, token, or
 *    API key before any business query is executed."
 *
 * Resolution order:
 *  1. X-Tenant-Code header (always supported - simplest for local/dev use
 *     and for server-to-server integrations).
 *  2. Subdomain of the Host header, e.g. abc.monetixsolutions.com -> "abc",
 *     used when TENANT_RESOLUTION_MODE=subdomain.
 *
 * The resolved tenant is attached to req.tenant. Every downstream repository
 * call must filter by req.tenant.id - there is no implicit global scope.
 */
export async function tenantResolver(req: Request, res: Response, next: NextFunction) {
  try {
    const mode = process.env.TENANT_RESOLUTION_MODE ?? "header";
    let tenantCode: string | undefined;

    const headerCode = req.header("x-tenant-code");
    if (headerCode) {
      tenantCode = headerCode;
    } else if (mode === "subdomain") {
      const host = req.header("host") ?? "";
      const sub = host.split(".")[0];
      if (sub && sub !== "www") tenantCode = sub;
    }

    // Public/platform routes (auth-less tenant onboarding, health check) may
    // not carry tenant context yet.
    if (!tenantCode) {
      return next();
    }

    const tenant = await prisma.tenant.findFirst({
      where: {
        OR: [{ code: tenantCode }, { subdomain: tenantCode }],
      },
    });

    if (!tenant) {
      throw ApiError.notFound(`Unknown tenant "${tenantCode}"`);
    }
    if (tenant.status === "Suspended" || tenant.status === "Cancelled") {
      throw ApiError.forbidden(`Tenant is ${tenant.status.toLowerCase()}`);
    }

    req.tenant = {
      id: tenant.id,
      code: tenant.code,
      subdomain: tenant.subdomain,
      databaseMode: tenant.databaseMode,
      status: tenant.status,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** Guard for routes that must have a resolved tenant (almost everything). */
export function requireTenant(req: Request, res: Response, next: NextFunction) {
  if (!req.tenant) {
    return next(ApiError.badRequest("Missing tenant context (X-Tenant-Code header)"));
  }
  next();
}
