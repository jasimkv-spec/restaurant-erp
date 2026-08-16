import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { crudRouter } from "../../utils/crudFactory";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePermission } from "../../middleware/rbac";

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
    }),
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
      resetPolicy: z.enum(["Never", "Yearly", "Monthly"]).default("Never"),
      digitLength: z.number().int().min(1).max(12).default(6),
      padChar: z.string().length(1).default("0"),
      separator: z.string().max(3).default("-"),
      includeYear: z.boolean().default(false),
      yearFormat: z.enum(["YYYY", "YY"]).default("YYYY"),
      includeMonth: z.boolean().default(false),
    }),
    statusField: "resetPolicy", // no real status field on this master; activate/deactivate unused
  })
);

// --- Company Policies (generic on/off + config switches, BRD 5.1) ---------
router.get(
  "/company-policies/:companyId",
  requirePermission("Admin.CompanyPolicy.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const items = await prisma.companyPolicy.findMany({
      where: { tenantId, companyId: req.params.companyId },
    });
    res.json({ data: items });
  })
);

router.put(
  "/company-policies/:companyId/:policyKey",
  requirePermission("Admin.CompanyPolicy.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ value: z.any() });
    const { value } = schema.parse(req.body);
    const record = await prisma.companyPolicy.upsert({
      where: {
        tenantId_companyId_policyKey: {
          tenantId,
          companyId: req.params.companyId,
          policyKey: req.params.policyKey,
        },
      },
      update: { policyValue: value },
      create: { tenantId, companyId: req.params.companyId, policyKey: req.params.policyKey, policyValue: value },
    });
    res.json(record);
  })
);

export default router;
