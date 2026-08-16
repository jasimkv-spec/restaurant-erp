import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/asyncHandler";
import { ApiError } from "../../utils/errors";
import { requireRole } from "../../middleware/rbac";
import { requireAuth } from "../../middleware/auth";

const router = Router();

/**
 * Platform-level SaaS administration (BRD 5.17 / section 7.1 Hybrid SaaS
 * Tenancy). These routes are NOT tenant-scoped - they manage tenants
 * themselves - so they skip the tenant resolver entirely and instead
 * require a Super Admin JWT (see BRD section 8 "Super Admin: Tenant
 * management, subscription, support access, platform configuration").
 */

router.get(
  "/tenants",
  requireAuth,
  requireRole("SuperAdmin"),
  asyncHandler(async (req, res) => {
    const items = await prisma.tenant.findMany({ include: { plan: true, modules: true }, orderBy: { createdAt: "desc" } });
    res.json({ data: items });
  })
);

router.post(
  "/tenants",
  asyncHandler(async (req, res) => {
    // Tenant onboarding is intentionally open (no existing tenant to auth
    // against yet) but should sit behind a signed platform admin key or an
    // invite-only signup flow in production - see BRD 5.17 "Tenant/client
    // master ... onboarding".
    const schema = z.object({
      code: z.string().min(1).max(50),
      name: z.string().min(1),
      subdomain: z.string().min(1).max(100),
      planId: z.string().uuid().optional(),
      databaseMode: z.enum(["Shared", "Dedicated"]).default("Shared"),
      timezone: z.string().default("UTC"),
    });
    const payload = schema.parse(req.body);

    const existing = await prisma.tenant.findFirst({
      where: { OR: [{ code: payload.code }, { subdomain: payload.subdomain }] },
    });
    if (existing) throw ApiError.conflict("Tenant code or subdomain already in use");

    const tenant = await prisma.tenant.create({ data: { ...payload, status: "Trial" } });
    res.status(201).json(tenant);
  })
);

router.post(
  "/tenants/:id/status",
  requireAuth,
  requireRole("SuperAdmin"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ status: z.enum(["Trial", "Active", "Suspended", "Cancelled"]) });
    const { status } = schema.parse(req.body);
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) throw ApiError.notFound();
    const updated = await prisma.tenant.update({ where: { id: tenant.id }, data: { status } });
    res.json(updated);
  })
);

// --- Subscription Plans -----------------------------------------------------------
router.get(
  "/subscription-plans",
  asyncHandler(async (req, res) => {
    const items = await prisma.subscriptionPlan.findMany({ orderBy: { basePrice: "asc" } });
    res.json({ data: items });
  })
);

router.post(
  "/subscription-plans",
  requireAuth,
  requireRole("SuperAdmin"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      code: z.string().min(1).max(50),
      name: z.string().min(1),
      billingCycle: z.enum(["Monthly", "Annual"]),
      basePrice: z.number().nonnegative().default(0),
    });
    const payload = schema.parse(req.body);
    const plan = await prisma.subscriptionPlan.create({ data: payload });
    res.status(201).json(plan);
  })
);

// --- Tenant Module Entitlements -----------------------------------------------------------
router.post(
  "/tenant-modules",
  requireAuth,
  requireRole("SuperAdmin"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      tenantId: z.string().uuid(),
      moduleCode: z.enum([
        "Admin",
        "Security",
        "Inventory",
        "Procurement",
        "Recipe",
        "Sales",
        "Consumption",
        "Finance",
        "Workflow",
        "SaaS",
      ]),
      enabled: z.boolean().default(true),
    });
    const payload = schema.parse(req.body);
    const record = await prisma.tenantModule.upsert({
      where: { tenantId_moduleCode: { tenantId: payload.tenantId, moduleCode: payload.moduleCode } },
      update: { enabled: payload.enabled },
      create: payload,
    });
    res.json(record);
  })
);

router.get(
  "/tenant-modules/:tenantId",
  requireAuth,
  requireRole("SuperAdmin"),
  asyncHandler(async (req, res) => {
    const items = await prisma.tenantModule.findMany({ where: { tenantId: req.params.tenantId } });
    res.json({ data: items });
  })
);

export default router;
