import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { ApiError } from "../utils/errors";

interface JwtPayload {
  userId: string;
  tenantId: string;
  email: string;
  roles: string[];
  permissions: string[];
}

/** Verifies the Bearer JWT and attaches req.user. Also cross-checks that the
 * token's tenant matches the tenant resolved for this request, so a token
 * issued for one tenant can never be replayed against another. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      throw ApiError.unauthorized("Missing bearer token");
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET is not configured");

    const payload = jwt.verify(token, secret) as JwtPayload;

    if (req.tenant && req.tenant.id !== payload.tenantId) {
      throw ApiError.forbidden("Token does not belong to this tenant");
    }

    req.user = {
      userId: payload.userId,
      tenantId: payload.tenantId,
      email: payload.email,
      roles: payload.roles ?? [],
      permissions: payload.permissions ?? [],
    };

    // If tenant wasn't resolved via header/subdomain, trust the token's tenant.
    if (!req.tenant) {
      req.tenant = {
        id: payload.tenantId,
        code: "",
        subdomain: "",
        databaseMode: "Shared",
        status: "Active",
      };
    }

    next();
  } catch (err) {
    if (err instanceof ApiError) return next(err);
    next(ApiError.unauthorized("Invalid or expired token"));
  }
}

export type { JwtPayload };
