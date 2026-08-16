import { Router } from "express";
import { z, ZodTypeAny } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "./asyncHandler";
import { ApiError } from "./errors";
import { requirePermission, hasPermission } from "../middleware/rbac";
import { writeAuditLog } from "../services/auditService";

/**
 * Generic tenant-scoped CRUD router factory, used for straightforward
 * master-data screens (companies, branches, warehouses, UOMs, item
 * categories, vendors, customers, chart of accounts, etc.) so the same
 * list/get/create/update/deactivate behaviour isn't hand-written ~30 times.
 *
 * Every query is scoped by req.tenant.id, matching the ERD blueprint's
 * tenant isolation rule ("All repository/query APIs must require tenant
 * context explicitly").
 *
 * Transactional documents with real business logic (Material Request, PO,
 * GRN, Purchase Invoice, Vendor Payment, Sales Import, Consumption Posting,
 * Journal Entry) are NOT built with this factory - see src/modules/*
 * for their dedicated controllers.
 */

// Minimal shape shared by every Prisma delegate we use here.
interface Delegate {
  findMany: (args: any) => Promise<any[]>;
  count: (args: any) => Promise<number>;
  findFirst: (args: any) => Promise<any>;
  create: (args: any) => Promise<any>;
  update: (args: any) => Promise<any>;
}

export interface CrudOptions {
  /** e.g. "Admin.Company", used to build "<module>.<screen>.<action>" permission strings */
  permissionKey: string;
  /** Zod schema for create payloads */
  createSchema: ZodTypeAny;
  /** Zod schema for update payloads (defaults to createSchema.partial()) */
  updateSchema?: ZodTypeAny;
  /** Extra Prisma `include` applied to list/get */
  include?: Record<string, unknown>;
  /** Default order-by */
  orderBy?: Record<string, "asc" | "desc">;
  /** Field used for soft-deactivate instead of hard delete (default "status") */
  statusField?: string;
  /**
   * Fields to mask in GET (list + detail) responses unless the requester
   * holds requiredPermission - BRD 5.2 "sensitive field controls" (bank
   * details, cost). Masked values come back as null with the field name
   * added to a "_masked" array on the record, so the UI can show a
   * "hidden - insufficient permission" affordance instead of a blank that
   * looks like missing data. Never affects create/update - a user without
   * the view permission still can't see what they wrote, but the field
   * itself is unrestricted to set (matches how cost fields usually work:
   * anyone entering a GRN can key in a cost, not everyone downstream can
   * see it later).
   */
  sensitiveFields?: { fields: string[]; requiredPermission: string };
}

function maskSensitive<T extends Record<string, any>>(record: T, opts: CrudOptions, req: { user?: any }): T {
  if (!opts.sensitiveFields || !record) return record;
  if (hasPermission(req as any, opts.sensitiveFields.requiredPermission)) return record;
  const masked: Record<string, any> = { ...record, _masked: [] as string[] };
  for (const field of opts.sensitiveFields.fields) {
    if (field in masked) {
      masked[field] = null;
      (masked._masked as string[]).push(field);
    }
  }
  return masked as T;
}

export function crudRouter(delegate: Delegate, opts: CrudOptions): Router {
  const router = Router();
  const updateSchema = opts.updateSchema ?? (opts.createSchema as z.ZodObject<any>).partial();
  const statusField = opts.statusField ?? "status";

  router.get(
    "/",
    requirePermission(`${opts.permissionKey}.View`),
    asyncHandler(async (req, res) => {
      const tenantId = req.tenant!.id;
      const page = Math.max(1, Number(req.query.page ?? 1));
      const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50)));
      const search = typeof req.query.search === "string" ? req.query.search : undefined;

      const where: Record<string, unknown> = { tenantId };
      if (search) {
        where.OR = [
          { code: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
        ];
      }

      const [items, total] = await Promise.all([
        delegate.findMany({
          where,
          include: opts.include,
          orderBy: opts.orderBy ?? { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        delegate.count({ where }),
      ]);

      res.json({ data: items.map((item) => maskSensitive(item, opts, req)), page, pageSize, total });
    })
  );

  router.get(
    "/:id",
    requirePermission(`${opts.permissionKey}.View`),
    asyncHandler(async (req, res) => {
      const tenantId = req.tenant!.id;
      const record = await delegate.findFirst({
        where: { id: req.params.id, tenantId },
        include: opts.include,
      });
      if (!record) throw ApiError.notFound();
      res.json(maskSensitive(record, opts, req));
    })
  );

  router.post(
    "/",
    requirePermission(`${opts.permissionKey}.Create`),
    asyncHandler(async (req, res) => {
      const tenantId = req.tenant!.id;
      const payload = opts.createSchema.parse(req.body);
      const record = await delegate.create({ data: { ...payload, tenantId } });
      await writeAuditLog(prisma, {
        tenantId,
        userId: req.user?.userId,
        moduleCode: opts.permissionKey,
        recordTable: opts.permissionKey,
        recordId: record.id,
        action: "Created",
        newValue: payload,
      });
      res.status(201).json(record);
    })
  );

  router.put(
    "/:id",
    requirePermission(`${opts.permissionKey}.Edit`),
    asyncHandler(async (req, res) => {
      const tenantId = req.tenant!.id;
      const existing = await delegate.findFirst({ where: { id: req.params.id, tenantId } });
      if (!existing) throw ApiError.notFound();

      const payload = updateSchema.parse(req.body);
      const record = await delegate.update({ where: { id: req.params.id }, data: payload });
      await writeAuditLog(prisma, {
        tenantId,
        userId: req.user?.userId,
        moduleCode: opts.permissionKey,
        recordTable: opts.permissionKey,
        recordId: record.id,
        action: "Edited",
        oldValue: existing,
        newValue: payload,
      });
      res.json(record);
    })
  );

  router.post(
    "/:id/deactivate",
    requirePermission(`${opts.permissionKey}.Edit`),
    asyncHandler(async (req, res) => {
      const tenantId = req.tenant!.id;
      const existing = await delegate.findFirst({ where: { id: req.params.id, tenantId } });
      if (!existing) throw ApiError.notFound();
      const record = await delegate.update({
        where: { id: req.params.id },
        data: { [statusField]: "Inactive" },
      });
      await writeAuditLog(prisma, {
        tenantId,
        userId: req.user?.userId,
        moduleCode: opts.permissionKey,
        recordTable: opts.permissionKey,
        recordId: record.id,
        action: "Deactivated",
      });
      res.json(record);
    })
  );

  router.post(
    "/:id/activate",
    requirePermission(`${opts.permissionKey}.Edit`),
    asyncHandler(async (req, res) => {
      const tenantId = req.tenant!.id;
      const existing = await delegate.findFirst({ where: { id: req.params.id, tenantId } });
      if (!existing) throw ApiError.notFound();
      const record = await delegate.update({
        where: { id: req.params.id },
        data: { [statusField]: "Active" },
      });
      await writeAuditLog(prisma, {
        tenantId,
        userId: req.user?.userId,
        moduleCode: opts.permissionKey,
        recordTable: opts.permissionKey,
        recordId: record.id,
        action: "Activated",
      });
      res.json(record);
    })
  );

  return router;
}

export { z };
export { prisma };
