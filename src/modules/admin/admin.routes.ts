import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { crudRouter } from "../../utils/crudFactory";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePermission } from "../../middleware/rbac";
import { ApiError } from "../../utils/errors";

const router = Router();

// --- Companies --------------------------------------------------------
router.use(
  "/companies",
  crudRouter(prisma.company, {
    permissionKey: "Admin.Company",
    createSchema: z.object({
      code: z.string().min(1).max(20),
      name: z.string().min(1).max(150),
      legalName: z.string().max(200).optional(),
      baseCurrencyId: z.string().uuid().optional(),
      taxNo: z.string().optional(),
      registrationNumber: z.string().optional(),
      contactNumber: z.string().optional(),
      address: z.string().optional(),
      logoUrl: z.string().optional(),
      dateFormat: z.string().default("dd-MM-yyyy"),
      timeFormat: z.enum(["24h", "12h"]).default("24h"),
      transactionHeaderText: z.string().optional(),
      transactionFooterText: z.string().optional(),
    }),
    include: { baseCurrency: true },
  })
);

// --- Branches (each branch belongs to exactly one company) --------------
router.use(
  "/branches",
  crudRouter(prisma.branch, {
    permissionKey: "Admin.Branch",
    createSchema: z.object({
      companyId: z.string().uuid(), // which company this branch is mapped to
      code: z.string().min(1).max(20),
      name: z.string().min(1),
      branchType: z.enum(["Head Office", "Outlet", "Central Kitchen", "Warehouse", "Franchise Outlet"]),
      defaultWarehouseId: z.string().uuid().optional(),
      profitCentreId: z.string().uuid().optional(),
    }),
    include: { warehouses: true },
  })
);

// --- Warehouses -----------------------------------------------------------
router.use(
  "/warehouses",
  crudRouter(prisma.warehouse, {
    permissionKey: "Admin.Warehouse",
    createSchema: z.object({
      branchId: z.string().uuid(),
      code: z.string().min(1).max(20),
      name: z.string().min(1),
      warehouseType: z.enum([
        "Raw Material",
        "Kitchen",
        "Finished Goods",
        "Dispatch",
        "Quarantine",
        "Rejected",
        "In-Transit",
      ]),
      isQuarantine: z.boolean().default(false),
      isInTransit: z.boolean().default(false),
    }),
  })
);

// --- Cost Centres -----------------------------------------------------------
router.use(
  "/cost-centres",
  crudRouter(prisma.costCentre, {
    permissionKey: "Admin.CostCentre",
    createSchema: z.object({
      companyId: z.string().uuid(),
      parentId: z.string().uuid().optional(),
      code: z.string().min(1).max(30),
      name: z.string().min(1),
    }),
  })
);

// --- Profit Centres -----------------------------------------------------------
router.use(
  "/profit-centres",
  crudRouter(prisma.profitCentre, {
    permissionKey: "Admin.ProfitCentre",
    createSchema: z.object({
      companyId: z.string().uuid(),
      branchId: z.string().uuid().optional(),
      code: z.string().min(1).max(30),
      name: z.string().min(1),
    }),
  })
);

// --- Financial Periods -----------------------------------------------------------
router.use(
  "/financial-periods",
  crudRouter(prisma.financialPeriod, {
    permissionKey: "Admin.FinancialPeriod",
    createSchema: z.object({
      companyId: z.string().uuid(),
      fiscalYear: z.number().int(),
      monthNo: z.number().int().min(1).max(12),
      startDate: z.coerce.date(),
      endDate: z.coerce.date(),
    }),
    updateSchema: z.object({
      inventoryStatus: z.enum(["Open", "Soft Closed", "Closed", "Locked", "Reopened"]).optional(),
      financeStatus: z.enum(["Open", "Soft Closed", "Closed", "Locked", "Reopened"]).optional(),
    }),
    statusField: "financeStatus",
  })
);

// --- Document Series -----------------------------------------------------------
router.use(
  "/document-series",
  crudRouter(prisma.documentSeries, {
    permissionKey: "Admin.DocumentSeries",
    createSchema: z.object({
      companyId: z.string().uuid(),
      branchId: z.string().uuid().optional(),
      moduleCode: z.string().min(1),
      prefix: z.string().min(1).max(20),
      nextNo: z.number().int().positive().default(1),
      numberingMode: z.enum(["Auto", "Manual"]).default("Auto"),
      resetPolicy: z.enum(["Never", "Yearly", "Monthly"]).default("Never"),
      digitLength: z.number().int().min(1).max(12).default(6),
      padChar: z.string().length(1).default("0"),
      separator: z.string().max(3).default("-"),
      includeYear: z.boolean().default(false),
      yearFormat: z.enum(["YYYY", "YY"]).default("YYYY"),
      includeMonth: z.boolean().default(false),
    }),
    statusField: "resetPolicy", // no real status field on this master; activate/deactivate unused
    listFilters: ["moduleCode"],
  })
);

// --- Master Series (auto-prefix codes for Vendors, Customers, etc.) -------
// Tenant-wide (no companyId), unlike Document Series - see
// src/utils/masterNumber.ts for why. entityType is a free-form string so
// new master types (e.g. "Employee") can start using this without a
// schema change - just pass a new entityType from that module's route.
router.use(
  "/master-series",
  crudRouter(prisma.masterSeries, {
    permissionKey: "Admin.MasterSeries",
    createSchema: z.object({
      entityType: z.string().min(1).max(30),
      prefix: z.string().min(1).max(10),
      nextNo: z.number().int().positive().default(1),
      numberingMode: z.enum(["Auto", "Manual"]).default("Auto"),
      digitLength: z.number().int().min(1).max(12).default(4),
      padChar: z.string().length(1).default("0"),
      separator: z.string().max(3).default(""),
      includeYear: z.boolean().default(false),
      yearFormat: z.enum(["YYYY", "YY"]).default("YYYY"),
      includeMonth: z.boolean().default(false),
    }),
    statusField: "prefix", // no real status column; activate/deactivate unused
    listFilters: ["entityType"],
  })
);

// --- Company Policies (scoped rule table, BRD 5.1) -------------------------
// A policyType can have several rules, each narrowed to a branch/user/role
// (null = "All") - see src/services/policyRuleService.ts for how the most
// specific matching rule gets picked at check time. Plain list/create/
// delete rather than crudRouter: these rows are simple config, not
// audit-critical transactional data, so a hard delete (not
// activate/deactivate) is the right fit.
router.get(
  "/policy-rules",
  requirePermission("Admin.CompanyPolicy.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.companyId) where.companyId = req.query.companyId;
    const items = await prisma.policyRule.findMany({
      where,
      include: { branch: true, user: true, role: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: items });
  })
);

router.post(
  "/policy-rules",
  requirePermission("Admin.CompanyPolicy.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      branchId: z.string().uuid().optional(),
      userId: z.string().uuid().optional(),
      roleId: z.string().uuid().optional(),
      policyType: z.string().min(1),
      value: z.number().optional(),
      allow: z.boolean().default(true),
    });
    const payload = schema.parse(req.body);
    const record = await prisma.policyRule.create({
      data: { ...payload, tenantId },
      include: { branch: true, user: true, role: true },
    });
    res.status(201).json(record);
  })
);

router.delete(
  "/policy-rules/:id",
  requirePermission("Admin.CompanyPolicy.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.policyRule.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    await prisma.policyRule.delete({ where: { id: existing.id } });
    res.status(204).send();
  })
);

export default router;
