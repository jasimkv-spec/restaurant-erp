import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { crudRouter } from "../../utils/crudFactory";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePermission } from "../../middleware/rbac";
import { ApiError } from "../../utils/errors";

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
      // Units of a company's base currency per 1 unit of this currency.
      // Leave at 1 for whichever currency is set as the company's own
      // base currency.
      exchangeRate: z.number().positive().default(1),
    });
    const payload = schema.parse(req.body);
    const record = await prisma.currency.create({ data: payload });
    res.status(201).json(record);
  })
);

// Currencies are shared/global (no tenantId), but unlike the other
// platform-global lookups (Countries, Banks) the exchange rate genuinely
// needs to be editable over time as real-world rates move - so this one
// gets a PUT even though it has no crudRouter behind it.
router.put(
  "/currencies/:id",
  requirePermission("Masters.Currency.Edit"),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).optional(),
      decimalPrecision: z.number().int().min(0).max(6).optional(),
      exchangeRate: z.number().positive().optional(),
    });
    const payload = schema.parse(req.body);
    const existing = await prisma.currency.findUnique({ where: { id: req.params.id } });
    if (!existing) throw ApiError.notFound();
    const record = await prisma.currency.update({ where: { id: req.params.id }, data: payload });
    res.json(record);
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

// --- Tax Groups -------------------------------------------------------
// A bundle of taxes applied together on a document (e.g. Tourism Tax +
// Municipality Tax + VAT under one "Tourism" group) - not to be confused
// with Tax.taxGroup, which is an unrelated VAT-return classification
// (Standard rate / Zero rated / Exempt) on the individual tax record.
router.use(
  "/tax-groups",
  crudRouter(prisma.taxGroup, {
    permissionKey: "Masters.TaxGroup",
    createSchema: z.object({
      code: z.string().min(1).max(20),
      name: z.string().min(1),
    }),
    include: { taxes: { include: { tax: true } } },
  })
);

router.post(
  "/tax-groups/:id/taxes",
  requirePermission("Masters.TaxGroup.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ taxId: z.string().uuid() });
    const { taxId } = schema.parse(req.body);

    const group = await prisma.taxGroup.findFirst({ where: { id: req.params.id, tenantId } });
    if (!group) throw ApiError.notFound();
    const tax = await prisma.tax.findFirst({ where: { id: taxId, tenantId } });
    if (!tax) throw ApiError.badRequest("taxId not found");

    const existing = await prisma.taxGroupItem.findFirst({ where: { tenantId, taxGroupId: group.id, taxId } });
    if (existing) throw ApiError.badRequest("This tax is already in the group");

    const record = await prisma.taxGroupItem.create({
      data: { tenantId, taxGroupId: group.id, taxId },
      include: { tax: true },
    });
    res.status(201).json(record);
  })
);

router.delete(
  "/tax-groups/:id/taxes/:taxId",
  requirePermission("Masters.TaxGroup.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const item = await prisma.taxGroupItem.findFirst({
      where: { tenantId, taxGroupId: req.params.id, taxId: req.params.taxId },
    });
    if (!item) throw ApiError.notFound();
    await prisma.taxGroupItem.delete({ where: { id: item.id } });
    res.status(204).send();
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

router.put(
  "/uom-conversions/:id",
  requirePermission("Masters.UomConversion.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.uomConversion.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    const schema = z.object({
      itemId: z.string().uuid().optional(),
      fromUomId: z.string().uuid(),
      toUomId: z.string().uuid(),
      factor: z.number().positive(),
      effectiveFrom: z.coerce.date().optional(),
    });
    const payload = schema.parse(req.body);
    const record = await prisma.uomConversion.update({ where: { id: existing.id }, data: payload });
    res.json(record);
  })
);

// Hard delete - a conversion row that's already been used to resolve a
// baseQty on a submitted document has no FK pointing back at it (baseQty is
// just a snapshot number on the line, not a live reference), so unlike
// crudFactory's generic delete this one can't be blocked by a foreign-key
// error in practice. Kept the same try/catch shape anyway in case a future
// module ever does reference UomConversion directly.
router.delete(
  "/uom-conversions/:id",
  requirePermission("Masters.UomConversion.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.uomConversion.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    try {
      await prisma.uomConversion.delete({ where: { id: existing.id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2003" || err.code === "P2014")) {
        throw ApiError.badRequest("This conversion is referenced elsewhere and can't be deleted.");
      }
      throw err;
    }
    res.status(204).send();
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

// --- Shipment Types (Purchase Order header field: Road/Air/Sea/Any) ---------
router.use(
  "/shipment-types",
  crudRouter(prisma.shipmentType, {
    permissionKey: "Masters.ShipmentType",
    createSchema: z.object({
      code: z.string().min(1).max(20),
      name: z.string().min(1),
    }),
  })
);

export default router;
