import "express";

export interface AuthUser {
  userId: string;
  tenantId: string;
  email: string;
  roles: string[];
  permissions: string[]; // "moduleCode.screenCode.actionCode"
}

export interface TenantContext {
  id: string;
  code: string;
  subdomain: string;
  databaseMode: string;
  status: string;
}

declare global {
  namespace Express {
    interface Request {
      tenant?: TenantContext;
      user?: AuthUser;
    }
  }
}
