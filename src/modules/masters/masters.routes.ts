import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { crudRouter } from "../../utils/crudFactory";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePermission } from "../../middleware/rbac";

const router = Router();

// --- Countries (platform-global, not tenant-scoped) ------------------------
router.get(
  "/countries",
  requirePermission("Masters.Country.View"),
  asyncHandler(async (req, res) => {
    const items = await prisma.country.findMany({ orderBy: { name: "asc" } });
    res.json({ data: items });
  })
);
router.post(
  "/countries",
  requirePermission("Masters.Country.Create"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ code: z.string().length(2), name: z.string().min(1) });
    const record = await prisma.country.create({ data: schema.parse(req.body) });
    res.status(201).json(record);
  })
);

// --- Cities (platform-global, belongs to a country) -------------------------
router.get(
  "/cities",
  requirePermission("Masters.City.View"),
  asyncHandler(async (req, res) => {
    const where: Record<string, unknown> = {};
    if (req.query.countryId) where.countryId = req.query.countryId;
    const items = await prisma.city.findMany({ where, include: { country: true }, orderBy: { name: "asc" } });
    res.json({ data: items });
  })
);
router.post(
  "/cities",
  requirePermission("Masters.City.Create"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ countryId: z.string().uuid(), code: z.string().min(1), name: z.string().min(1) });
    const record = await prisma.city.create({ data: schema.parse(req.body) });
    res.status(201).json(record);
  })
);

// --- Areas (tenant-scoped delivery/address zones within a city) -------------
router.use(
  "/areas",
  crudRouter(prisma.area, {
    permissionKey: "Masters.Area",
    createSchema: z.object({
      cityId: z.string().uuid(),
      code: z.string().min(1).max(30),
      name: z.string().min(1),
    }),
    include: { city: { include: { country: true } } },
  })
);

// --- Banks (platform-global reference list, not tenant-scoped) ------------
router.get(
  "/banks",
  requirePermission("Masters.Bank.View"),
  asyncHandler(async (req, res) => {
    const items = await prisma.bank.findMany({ orderBy: { name: "asc" } });
    res.json({ data: items });
  })
);
router.post(
  "/banks",
  requirePermission("Masters.Bank.Create"),
  asyncHandler(async (req, res) => {
    const schema = z.object({ code: z.string().min(1).max(30), name: z.string().min(1) });
    const record = await prisma.bank.create({ data: schema.parse(req.body) });
    res.status(201).json(record);
  })
);

// --- Currencies (platform-global, not tenant-scoped) ----------------------
router.get(
  "/currencies",
  requirePermission("Masters.Currency.View"),
  asyncHandler(async (req, res) => {
    const items = await prisma.currency.findMany({ orderBy: { code: "asc" } });
    res.json({ data: items });
  })
);

router.post(
  "/currencies",
  requirePermission("Masters.Currency.Create"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      code: z.string().length(3),
      name: z.string().min(1),
      decimalPrecision: z.number().int().min(0).max(6).default(2),
    });
    const payload = schema.parse(req.body);
    const record = await prisma.currency.create({ data: payload });
    res.status(201).json(record);
  })
);

// --- Taxes -----------------------------------------------------------
router.use(
  "/taxes",
  crudRouter(prisma.tax, {
    permissionKey: "Masters.Tax",
    createSchema: z.object({
      code: z.string().min(1).max(20),
      name: z.string().min(1),
      rate: z.number().nonnegative(),
      taxType: z.string().default("VAT"),
      taxGroup: z.enum(["Standard rate", "Zero rated", "Exempt"]).default("Standard rate"),
    }),
  })
);

// --- UOMs -----------------------------------------------------------
router.use(
  "/uoms",
  crudRouter(prisma.uom, {
    permissionKey: "Masters.Uom",
    createSchema: z.object({
      code: z.string().min(1).max(10),
      name: z.string().min(1),
      decimalPrecision: z.number().int().min(0).max(6).default(3),
    }),
    statusField: "code", // UOM has no status column; activate/deactivate endpoints unused
  })
);

// --- UOM Conversions -----------------------------------------------------------
router.post(
  "/uom-conversions",
  requirePermission("Masters.UomConversion.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      itemId: z.string().uuid().optional(),
      fromUomId: z.string().uuid(),
      toUomId: z.string().uuid(),
      factor: z.number().positive(),
      effectiveFrom: z.coerce.date().optional(),
    });
    const payload = schema.parse(req.body);
    const record = await prisma.uomConversion.create({ data: { ...payload, tenantId } });
    res.status(201).json(record);
  })
);

router.get(
  "/uom-conversions",
  requirePermission("Masters.UomConversion.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.itemId) where.itemId = req.query.itemId;
    const items = await prisma.uomConversion.findMany({ where });
    res.json({ data: items });
  })
);

// --- Payment Terms -----------------------------------------------------------
router.use(
  "/terms",
  crudRouter(prisma.term, {
    permissionKey: "Masters.Term",
    createSchema: z.object({
      code: z.string().min(1).max(20),
      name: z.string().min(1),
      days: z.number().int().min(0).default(0),
    }),
  })
);

// --- Payment Methods -----------------------------------------------------------
router.use(
  "/payment-methods",
  crudRouter(prisma.paymentMethod, {
    permissionKey: "Masters.PaymentMethod",
    createSchema: z.object({
      code: z.string().min(1).max(20),
      name: z.string().min(1),
      type: z.enum(["Cash", "Card", "Online", "Aggregator", "Cheque", "Bank Transfer"]).default("Cash"),
    }),
  })
);

export default router;
