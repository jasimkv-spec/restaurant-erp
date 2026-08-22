import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { crudRouter } from "../../utils/crudFactory";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePermission, hasPermission } from "../../middleware/rbac";
import { ApiError } from "../../utils/errors";
import { nextDocumentNumber } from "../../utils/documentNumber";
import { postStockMovement } from "../../services/stockService";
import { postJournal, recordPostingException } from "../../services/journalService";
import { resolveCoaByCode } from "../../services/coaLookup";
import { triggerApproval } from "../../services/approvalService";
import { writeAuditLog } from "../../services/auditService";
import { resolvePolicy } from "../../services/policyRuleService";
import { resolveUomQty } from "../../utils/uomConversion";
import { computePoLineAmounts } from "../../services/poCalc";

const router = Router();

// --- Vendors --------------------------------------------------------------
router.use(
  "/vendors",
  crudRouter(prisma.vendor, {
    permissionKey: "Procurement.Vendor",
    createSchema: z.object({
      code: z.string().min(1).max(50),
      name: z.string().min(1),
      contactPerson: z.string().optional(),
      phone: z.string().optional(),
      whatsapp: z.string().optional(),
      email: z.string().email().optional(),
      address: z.string().optional(),
      countryId: z.string().uuid().optional(),
      cityId: z.string().uuid().optional(),
      areaId: z.string().uuid().optional(),
      taxNo: z.string().optional(),
      tradeLicenseNo: z.string().optional(),
      licenseExpiryDate: z.coerce.date().optional(),
      currencyId: z.string().uuid().optional(),
      paymentTermsId: z.string().uuid().optional(),
      creditLimit: z.number().nonnegative().optional(),
      bankName: z.string().optional(),
      bankAccountNo: z.string().optional(),
      iban: z.string().optional(),
      rating: z.enum(["Approved", "Pending", "Blacklisted"]).default("Pending"),
      payableGlId: z.string().uuid().optional(),
      notes: z.string().optional(),
    }),
    include: { country: true, city: true, area: true, paymentTerms: true, currency: true },
    sensitiveFields: { fields: ["bankName", "bankAccountNo", "iban"], requiredPermission: "Procurement.Vendor.ViewBankDetails" },
    autoCode: { field: "code", entityType: "Vendor", defaultPrefix: "SUP" },
  })
);

// --- Material Requests ------------------------------------------------------
const mrLineSchema = z.object({
  itemId: z.string().uuid(),
  requestedQty: z.number().positive(),
  uomId: z.string().uuid(),
  remark: z.string().optional(),
});

// Shared between create and edit - only create additionally needs
// companyId (to resolve the numbering series the one time mrNo is minted).
const mrHeaderSchema = z.object({
  branchId: z.string().uuid(),
  warehouseId: z.string().uuid().optional(),
  // Reflected onto RFQ/PO/GRN as they're generated from this MR, so a buyer
  // can trace any downstream document back to why it was raised.
  title: z.string().min(1),
  notes: z.string().optional(),
  requestType: z.enum(["Material", "Service"]).default("Material"),
  priority: z.enum(["Low", "Normal", "High", "Urgent"]).default("Normal"),
  sourceType: z.enum(["Branch", "Warehouse", "CentralKitchen", "Direct"]).optional(),
  // Transaction date - defaults to "now" (when the MR is created) but can be
  // backdated by an authorized user, same convention as most other documents.
  requestDate: z.coerce.date().optional(),
  // "Requested by" - when the requester needs the goods. Distinct from
  // validityDate below: this is informational, validityDate is enforced.
  requiredDate: z.coerce.date().optional(),
  // Hard cutoff - after this date the MR (and its lines) drop out of the MR
  // Consolidation pool and therefore out of RFQ/PO. See consolidation-pool.
  validityDate: z.coerce.date().optional(),
});

/** Resolves each line's baseQty (see MaterialRequestLine.baseQty comment) against the items' configured base UOM. */
async function computeLinesWithBaseQty(
  tx: Prisma.TransactionClient | typeof prisma,
  tenantId: string,
  lines: z.infer<typeof mrLineSchema>[]
) {
  const items = await tx.item.findMany({
    where: { tenantId, id: { in: lines.map((l) => l.itemId) } },
    select: { id: true, baseUomId: true },
  });
  const baseUomById = new Map(items.map((i) => [i.id, i.baseUomId]));

  return Promise.all(
    lines.map(async (l) => {
      const baseUomId = baseUomById.get(l.itemId);
      const baseQty = baseUomId
        ? await resolveUomQty(tx, { tenantId, itemId: l.itemId, fromUomId: l.uomId, toUomId: baseUomId, qty: l.requestedQty })
        : null;
      return { ...l, tenantId, baseQty };
    })
  );
}

router.get(
  "/material-requests",
  requirePermission("Procurement.MaterialRequest.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.branchId) where.branchId = req.query.branchId;
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.materialRequest.findMany({
      where,
      include: {
        lines: true,
        branch: true,
        requester: { select: { id: true, displayName: true, email: true } },
        approvedBy: { select: { id: true, displayName: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: items });
  })
);

/**
 * Lets the line-entry screen warn "this item already has an open MR for
 * this branch" before the user saves a duplicate by mistake. Open = any
 * status other than a side-branch dead end (there's currently no
 * Rejected/Cancelled status on MaterialRequest, so today that just means
 * every status - kept as an explicit exclusion list rather than an
 * inclusion list so a future terminal status doesn't need this route
 * updated to stay correct). excludeId lets an edit-in-progress MR ignore
 * its own lines when checking itself.
 *
 * Registered ahead of GET /material-requests/:id on purpose - Express
 * matches routes in registration order, and ":id" would otherwise swallow
 * "check-duplicate" as if it were an id (same reason consolidation-pool
 * below needs to stay ahead of it too).
 */
router.get(
  "/material-requests/check-duplicate",
  requirePermission("Procurement.MaterialRequest.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      itemId: z.string().uuid(),
      branchId: z.string().uuid(),
      excludeId: z.string().uuid().optional(),
    });
    const { itemId, branchId, excludeId } = schema.parse(req.query);

    const lines = await prisma.materialRequestLine.findMany({
      where: {
        tenantId,
        itemId,
        mr: {
          branchId,
          status: { notIn: ["Rejected", "Cancelled"] },
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
      },
      include: { mr: { select: { id: true, mrNo: true, status: true, requestDate: true, title: true } }, uom: true },
      orderBy: { mr: { requestDate: "desc" } },
      take: 10,
    });

    res.json({
      data: lines.map((l) => ({
        mrId: l.mr.id,
        mrNo: l.mr.mrNo,
        title: l.mr.title,
        status: l.mr.status,
        requestDate: l.mr.requestDate,
        requestedQty: l.requestedQty,
        uomCode: l.uom.code,
      })),
    });
  })
);

/**
 * Head-office view: every approved MR line across every branch (not just
 * one), grouped by item, so head office can see total tenant-wide demand
 * for an item before deciding whether to consolidate it into a purchase
 * (External -> RFQ/PO) or pull it from another branch's stock instead
 * (Internal -> inter-branch transfer). Lines already picked into an active
 * consolidation are excluded so nothing gets consolidated twice.
 *
 * Also registered ahead of GET /material-requests/:id - same
 * route-ordering reason as check-duplicate above.
 */
router.get(
  "/material-requests/consolidation-pool",
  requirePermission("Procurement.MrConsolidation.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const status = typeof req.query.status === "string" ? req.query.status : "Approved";

    const alreadyConsolidated = await prisma.mrConsolidationLine.findMany({
      where: { tenantId, consolidation: { status: { not: "Cancelled" } } },
      select: { mrLineId: true },
    });
    const excludeLineIds = alreadyConsolidated.map((l) => l.mrLineId);

    const lines = await prisma.materialRequestLine.findMany({
      where: {
        tenantId,
        id: { notIn: excludeLineIds },
        // Validity date is a demand-planning cutoff (see MaterialRequest
        // model comment): an expired MR can still be viewed/reported on,
        // it just drops out of the pool that consolidation/RFQ/PO draw
        // from, same way an already-consolidated line is excluded above.
        mr: { status, OR: [{ validityDate: null }, { validityDate: { gte: new Date() } }] },
      },
      include: { item: true, uom: true, mr: { include: { branch: true } } },
      orderBy: { mr: { requestDate: "asc" } },
    });

    const byItem = new Map<
      string,
      { itemId: string; itemCode: string; itemName: string; uomCode: string; totalQty: number; branches: unknown[] }
    >();
    for (const line of lines) {
      const qty = Number(line.approvedQty ?? line.requestedQty);
      if (!byItem.has(line.itemId)) {
        byItem.set(line.itemId, {
          itemId: line.itemId,
          itemCode: line.item.code,
          itemName: line.item.name,
          uomCode: line.uom.code,
          totalQty: 0,
          branches: [],
        });
      }
      const entry = byItem.get(line.itemId)!;
      entry.totalQty += qty;
      entry.branches.push({
        branchId: line.mr.branchId,
        branchName: line.mr.branch.name,
        mrId: line.mrId,
        mrNo: line.mr.mrNo,
        mrLineId: line.id,
        qty,
      });
    }

    res.json({ data: Array.from(byItem.values()) });
  })
);

/**
 * Approved MRs available to recall whole into a new Purchase Order (task:
 * "Recall from MR" - search/browse one MR, pull in every line on it, then
 * add/remove lines on the PO as needed). Whole-document rather than
 * line-level: once any line on an MR has been pulled into a PO, the entire
 * MR drops off this list for good, even if the PO editor later removes some
 * of those lines - an MR that's been raised against is considered spoken
 * for as a document, not a per-line pool of demand.
 *
 * Excludes an MR if any of its lines are sitting in a live (non-Cancelled)
 * MR Consolidation (same exclusion consolidation-pool uses) or if any of
 * its lines have already been pulled into any Purchase Order line via
 * sourceMrId, so the same demand can't be double-ordered.
 *
 * ?search= filters by MR number (case-insensitive contains) for the
 * type-to-search picker; omit to browse the full list.
 *
 * Registered ahead of GET /material-requests/:id for the same route-
 * ordering reason as check-duplicate/consolidation-pool above.
 */
router.get(
  "/material-requests/po-pool",
  requirePermission("Procurement.PurchaseOrder.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

    const [consolidated, alreadyOnPo] = await Promise.all([
      prisma.mrConsolidationLine.findMany({
        where: { tenantId, consolidation: { status: { not: "Cancelled" } } },
        select: { mrLineId: true },
      }),
      prisma.purchaseOrderLine.findMany({
        where: { tenantId, sourceMrId: { not: null } },
        select: { sourceMrId: true },
      }),
    ]);

    const excludeMrIds = new Set<string>();
    alreadyOnPo.forEach((l) => l.sourceMrId && excludeMrIds.add(l.sourceMrId));
    if (consolidated.length) {
      const consolidatedLines = await prisma.materialRequestLine.findMany({
        where: { id: { in: consolidated.map((l) => l.mrLineId) } },
        select: { mrId: true },
      });
      consolidatedLines.forEach((l) => excludeMrIds.add(l.mrId));
    }

    const mrs = await prisma.materialRequest.findMany({
      where: {
        tenantId,
        status: "Approved",
        OR: [{ validityDate: null }, { validityDate: { gte: new Date() } }],
        id: { notIn: Array.from(excludeMrIds) },
        ...(search ? { mrNo: { contains: search, mode: "insensitive" as const } } : {}),
      },
      include: { branch: true, _count: { select: { lines: true } } },
      orderBy: { requestDate: "asc" },
      take: 50,
    });

    res.json({
      data: mrs.map((mr) => ({
        mrId: mr.id,
        mrNo: mr.mrNo,
        branchId: mr.branchId,
        branchName: mr.branch.name,
        requestDate: mr.requestDate,
        lineCount: mr._count.lines,
      })),
    });
  })
);

router.get(
  "/material-requests/:id",
  requirePermission("Procurement.MaterialRequest.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.materialRequest.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        lines: { include: { item: { include: { baseUom: true } }, uom: true } },
        // Nested company - the print letterhead (logo, legal name, address,
        // tax/registration no., transaction header/footer text) reads from
        // record.branch.company. See DocumentScreen.printRecord.
        branch: { include: { company: true } },
        requester: { select: { id: true, displayName: true, email: true } },
        approvedBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    if (!record) throw ApiError.notFound();
    res.json(record);
  })
);

router.post(
  "/material-requests",
  requirePermission("Procurement.MaterialRequest.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = mrHeaderSchema.extend({
      companyId: z.string().uuid(),
      lines: z.array(mrLineSchema).min(1),
    });
    const payload = schema.parse(req.body);

    const record = await prisma.$transaction(async (tx) => {
      const mrNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId: payload.companyId,
        moduleCode: "MaterialRequest",
        defaultPrefix: "MR",
      });

      const linesWithBaseQty = await computeLinesWithBaseQty(tx, tenantId, payload.lines);

      return tx.materialRequest.create({
        data: {
          tenantId,
          branchId: payload.branchId,
          warehouseId: payload.warehouseId,
          requesterId: req.user?.userId,
          title: payload.title,
          notes: payload.notes,
          requestType: payload.requestType,
          priority: payload.priority,
          ...(payload.sourceType ? { sourceType: payload.sourceType } : {}),
          ...(payload.requestDate ? { requestDate: payload.requestDate } : {}),
          requiredDate: payload.requiredDate,
          validityDate: payload.validityDate,
          mrNo,
          lines: {
            create: linesWithBaseQty,
          },
        },
        include: { lines: true },
      });
    });

    res.status(201).json(record);
  })
);

router.put(
  "/material-requests/:id",
  requirePermission("Procurement.MaterialRequest.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const payload = mrHeaderSchema.extend({ lines: z.array(mrLineSchema).min(1) }).parse(req.body);

    const existing = await prisma.materialRequest.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    if (existing.status !== "Draft") {
      throw ApiError.badRequest(`Cannot edit an MR in status ${existing.status} - only Draft MRs can be edited`);
    }

    const record = await prisma.$transaction(async (tx) => {
      const linesWithBaseQty = await computeLinesWithBaseQty(tx, tenantId, payload.lines);
      // Simplest correct way to let lines be added/removed/reordered on
      // edit: replace the set entirely rather than diffing old vs new.
      // Safe here because a Draft MR's lines can't yet be referenced by
      // anything downstream (consolidation/RFQ/PO only ever pull from
      // Approved MRs) - see the consolidation-pool query above.
      await tx.materialRequestLine.deleteMany({ where: { mrId: existing.id } });
      return tx.materialRequest.update({
        where: { id: existing.id },
        data: {
          branchId: payload.branchId,
          warehouseId: payload.warehouseId,
          title: payload.title,
          notes: payload.notes,
          requestType: payload.requestType,
          priority: payload.priority,
          ...(payload.sourceType ? { sourceType: payload.sourceType } : {}),
          ...(payload.requestDate ? { requestDate: payload.requestDate } : {}),
          requiredDate: payload.requiredDate,
          validityDate: payload.validityDate,
          lines: { create: linesWithBaseQty },
        },
        include: { lines: true },
      });
    });

    await writeAuditLog(prisma, {
      tenantId,
      userId: req.user?.userId,
      moduleCode: "Procurement.MaterialRequest",
      recordTable: "material_requests",
      recordId: record.id,
      action: "Edited",
      oldValue: existing,
      newValue: payload,
    });

    res.json(record);
  })
);

router.delete(
  "/material-requests/:id",
  requirePermission("Procurement.MaterialRequest.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.materialRequest.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    if (existing.status !== "Draft") {
      throw ApiError.badRequest(`Cannot delete an MR in status ${existing.status} - only Draft MRs can be deleted`);
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.materialRequestLine.deleteMany({ where: { mrId: existing.id } });
        await tx.materialRequest.delete({ where: { id: existing.id } });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2003" || err.code === "P2014")) {
        throw ApiError.badRequest("This material request is referenced elsewhere and can't be deleted.");
      }
      throw err;
    }

    await writeAuditLog(prisma, {
      tenantId,
      userId: req.user?.userId,
      moduleCode: "Procurement.MaterialRequest",
      recordTable: "material_requests",
      recordId: req.params.id,
      action: "Deleted",
      oldValue: existing,
    });

    res.status(204).send();
  })
);

router.post(
  "/material-requests/:id/submit",
  requirePermission("Procurement.MaterialRequest.Submit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.materialRequest.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    if (existing.status !== "Draft") throw ApiError.badRequest(`Cannot submit MR in status ${existing.status}`);
    const record = await prisma.materialRequest.update({ where: { id: existing.id }, data: { status: "Submitted" } });
    await triggerApproval(prisma, { tenantId, moduleCode: "Procurement.MaterialRequest", recordId: record.id });
    await writeAuditLog(prisma, {
      tenantId,
      userId: req.user?.userId,
      moduleCode: "Procurement.MaterialRequest",
      recordTable: "material_requests",
      recordId: record.id,
      action: "Submitted",
    });
    res.json(record);
  })
);

router.post(
  "/material-requests/:id/approve",
  requirePermission("Procurement.MaterialRequest.Approve"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      lineApprovals: z.array(z.object({ lineId: z.string().uuid(), approvedQty: z.number().nonnegative() })).optional(),
    });
    const { lineApprovals } = schema.parse(req.body);

    const existing = await prisma.materialRequest.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    if (existing.status !== "Submitted") throw ApiError.badRequest(`Cannot approve MR in status ${existing.status}`);

    await prisma.$transaction(async (tx) => {
      if (lineApprovals) {
        for (const la of lineApprovals) {
          await tx.materialRequestLine.update({ where: { id: la.lineId }, data: { approvedQty: la.approvedQty } });
        }
      } else {
        await tx.materialRequestLine.updateMany({
          where: { mrId: existing.id },
          data: {}, // no-op; approvedQty left null means "approved as requested" by convention
        });
      }
      // Taken from the authenticated caller, not the request body - who
      // approved a document should always be whoever actually clicked
      // Approve, never something the client can supply itself.
      await tx.materialRequest.update({
        where: { id: existing.id },
        data: { status: "Approved", approvedById: req.user?.userId, approvedAt: new Date() },
      });
    });

    const record = await prisma.materialRequest.findUnique({
      where: { id: existing.id },
      include: {
        lines: true,
        requester: { select: { id: true, displayName: true, email: true } },
        approvedBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    await writeAuditLog(prisma, {
      tenantId,
      userId: req.user?.userId,
      moduleCode: "Procurement.MaterialRequest",
      recordTable: "material_requests",
      recordId: existing.id,
      action: "Approved",
    });
    res.json(record);
  })
);

// --- MR Consolidation -------------------------------------------------------

router.post(
  "/mr-consolidations",
  requirePermission("Procurement.MrConsolidation.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      fulfillmentType: z.enum(["External", "Internal"]).default("External"),
      mrLineIds: z.array(z.string().uuid()).min(1),
    });
    const payload = schema.parse(req.body);

    const lines = await prisma.materialRequestLine.findMany({
      where: { id: { in: payload.mrLineIds }, tenantId },
    });
    if (lines.length !== payload.mrLineIds.length) {
      throw ApiError.badRequest("One or more MR lines not found");
    }

    const record = await prisma.$transaction(async (tx) => {
      const consolidationNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId: payload.companyId,
        moduleCode: "MrConsolidation",
        defaultPrefix: "CONS",
      });
      return tx.mrConsolidation.create({
        data: {
          tenantId,
          consolidationNo,
          fulfillmentType: payload.fulfillmentType,
          lines: {
            create: lines.map((l) => ({
              tenantId,
              mrId: l.mrId,
              mrLineId: l.id,
              itemId: l.itemId,
              qty: l.approvedQty ?? l.requestedQty,
            })),
          },
        },
        include: { lines: true },
      });
    });

    res.status(201).json(record);
  })
);

router.get(
  "/mr-consolidations",
  requirePermission("Procurement.MrConsolidation.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.fulfillmentType) where.fulfillmentType = req.query.fulfillmentType;
    const items = await prisma.mrConsolidation.findMany({ where, include: { lines: true } });
    res.json({ data: items });
  })
);

router.get(
  "/mr-consolidations/:id",
  requirePermission("Procurement.MrConsolidation.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.mrConsolidation.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: { include: { item: true, mrLine: { include: { uom: true } }, mr: { include: { branch: true } } } } },
    });
    if (!record) throw ApiError.notFound();
    res.json(record);
  })
);

/**
 * Converts an Internal-fulfillment consolidation into inter-branch
 * transfers - one transfer per destination branch, since a transfer moves
 * stock into a single branch/warehouse. All lines are drawn from one
 * supplying branch/warehouse.
 */
router.post(
  "/mr-consolidations/:id/convert-to-transfer",
  requirePermission("Procurement.MrConsolidation.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      fromBranchId: z.string().uuid(),
      fromWarehouseId: z.string().uuid(),
      transitWarehouseId: z.string().uuid(),
      // destination warehouse to receive into, keyed by the requesting branch's id
      toWarehouseByBranch: z.record(z.string().uuid()),
    });
    const payload = schema.parse(req.body);

    const consolidation = await prisma.mrConsolidation.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: { include: { mr: true } } },
    });
    if (!consolidation) throw ApiError.notFound();
    if (consolidation.fulfillmentType !== "Internal") {
      throw ApiError.badRequest("This consolidation is marked External - convert it via RFQ/PO instead");
    }

    const fromBranch = await prisma.branch.findFirst({ where: { id: payload.fromBranchId, tenantId } });
    if (!fromBranch) throw ApiError.badRequest("fromBranchId not found");

    const transitWarehouse = await prisma.warehouse.findFirst({ where: { id: payload.transitWarehouseId, tenantId } });
    if (!transitWarehouse) throw ApiError.badRequest("transitWarehouseId not found");
    if (!transitWarehouse.isInTransit) {
      throw ApiError.badRequest("transitWarehouseId must point to a warehouse flagged isInTransit = true");
    }

    const byBranch = new Map<string, typeof consolidation.lines>();
    for (const line of consolidation.lines) {
      if (!line.mr) throw ApiError.badRequest(`Consolidation line ${line.id} has no linked material request`);
      const branchId = line.mr.branchId;
      byBranch.set(branchId, [...(byBranch.get(branchId) ?? []), line]);
    }

    const createdTransfers = await prisma.$transaction(async (tx) => {
      const transfers: any[] = [];
      for (const [branchId, lines] of byBranch) {
        const toWarehouseId = payload.toWarehouseByBranch[branchId];
        if (!toWarehouseId) throw ApiError.badRequest(`Missing destination warehouse for branch ${branchId}`);

        const transferNo = await nextDocumentNumber(tx, {
          tenantId,
          companyId: fromBranch.companyId,
          moduleCode: "StockTransfer",
          defaultPrefix: "IBT",
        });
        const transfer = await tx.stockTransfer.create({
          data: {
            tenantId,
            transferNo,
            fromBranchId: payload.fromBranchId,
            toBranchId: branchId,
            fromWarehouseId: payload.fromWarehouseId,
            toWarehouseId,
            transitWarehouseId: payload.transitWarehouseId,
            sourceConsolidationId: consolidation.id,
            lines: {
              create: lines.map((l) => ({
                tenantId,
                itemId: l.itemId,
                qty: l.qty,
                sourceMrConsolidationLineId: l.id,
              })),
            },
          },
          include: { lines: true },
        });
        transfers.push(transfer);
      }
      await tx.mrConsolidation.update({ where: { id: consolidation.id }, data: { status: "Converted" } });
      return transfers;
    });

    res.status(201).json({ consolidationId: consolidation.id, stockTransfers: createdTransfers });
  })
);

/**
 * Converts an External-fulfillment consolidation into a single RFQ, ready
 * to send out for vendor quotes. All consolidation lines become RFQ lines
 * in one RFQ regardless of how many branches originally contributed -
 * sending several vendors one combined quantity is the whole point of
 * consolidating in the first place. Each RFQ line keeps sourceMrLineId so
 * the originating branch/MR is still traceable end to end. Once quotes come
 * in, the existing RFQ -> PO flow (see /rfqs/:id/select and
 * /rfqs/:id/convert-to-po below) takes it the rest of the way - no separate
 * "convert straight to PO" path, since skipping the quote step defeats the
 * purpose of consolidating multiple branches' demand before buying.
 */
router.post(
  "/mr-consolidations/:id/convert-to-rfq",
  requirePermission("Procurement.MrConsolidation.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      branchId: z.string().uuid().optional(),
      notes: z.string().optional(),
    });
    const payload = schema.parse(req.body);

    const consolidation = await prisma.mrConsolidation.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: { include: { mrLine: true } } },
    });
    if (!consolidation) throw ApiError.notFound();
    if (consolidation.fulfillmentType !== "External") {
      throw ApiError.badRequest("This consolidation is marked Internal - convert it via Transfer instead");
    }
    if (consolidation.status !== "Draft") {
      throw ApiError.badRequest(`Cannot convert a consolidation in status ${consolidation.status}`);
    }

    const record = await prisma.$transaction(async (tx) => {
      const rfqNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId: payload.companyId,
        moduleCode: "Rfq",
        defaultPrefix: "RFQ",
      });
      const rfq = await tx.rfq.create({
        data: {
          tenantId,
          rfqNo,
          branchId: payload.branchId,
          notes: payload.notes,
          lines: {
            create: consolidation.lines.map((l) => ({
              tenantId,
              itemId: l.itemId,
              qty: l.qty,
              uomId: l.mrLine.uomId,
              sourceMrLineId: l.mrLineId,
            })),
          },
        },
        include: { lines: true },
      });
      await tx.mrConsolidation.update({ where: { id: consolidation.id }, data: { status: "Converted" } });
      return rfq;
    });

    res.status(201).json({ consolidationId: consolidation.id, rfq: record });
  })
);

// --- RFQ (Request for Quotation) ---------------------------------------------
// Not in the original blueprint - added at the user's request as a step
// between MR consolidation and PO: send the same lines to several vendors,
// record what each one quotes, mark the winning quote per line, then
// convert the selected quotes straight into a PO (one PO per vendor, since
// a PO belongs to a single vendor).
const rfqLineSchema = z.object({
  itemId: z.string().uuid(),
  qty: z.number().positive(),
  uomId: z.string().uuid(),
  sourceMrLineId: z.string().uuid().optional(),
});

router.post(
  "/rfqs",
  requirePermission("Procurement.Rfq.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      branchId: z.string().uuid().optional(),
      notes: z.string().optional(),
      lines: z.array(rfqLineSchema).min(1),
    });
    const payload = schema.parse(req.body);

    const record = await prisma.$transaction(async (tx) => {
      const rfqNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId: payload.companyId,
        moduleCode: "Rfq",
        defaultPrefix: "RFQ",
      });
      return tx.rfq.create({
        data: {
          tenantId,
          rfqNo,
          branchId: payload.branchId,
          notes: payload.notes,
          lines: { create: payload.lines.map((l) => ({ ...l, tenantId })) },
        },
        include: { lines: true },
      });
    });

    res.status(201).json(record);
  })
);

router.get(
  "/rfqs",
  requirePermission("Procurement.Rfq.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.rfq.findMany({ where, include: { lines: true, branch: true }, orderBy: { createdAt: "desc" } });
    res.json({ data: items });
  })
);

router.get(
  "/rfqs/:id",
  requirePermission("Procurement.Rfq.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.rfq.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: { include: { item: true, uom: true, quotes: { include: { vendor: true } } } } },
    });
    if (!record) throw ApiError.notFound();
    res.json(record);
  })
);

router.post(
  "/rfqs/:id/send",
  requirePermission("Procurement.Rfq.Submit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.rfq.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    if (existing.status !== "Draft") throw ApiError.badRequest(`Cannot send RFQ in status ${existing.status}`);
    const record = await prisma.rfq.update({ where: { id: existing.id }, data: { status: "Sent" } });
    res.json(record);
  })
);

/** Records or updates one vendor's quoted price/lead time against one RFQ line. */
router.post(
  "/rfqs/:id/quotes",
  requirePermission("Procurement.Rfq.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const rfq = await prisma.rfq.findFirst({ where: { id: req.params.id, tenantId } });
    if (!rfq) throw ApiError.notFound();

    const schema = z.object({
      rfqLineId: z.string().uuid(),
      vendorId: z.string().uuid(),
      quotedPrice: z.number().nonnegative(),
      leadTimeDays: z.number().int().nonnegative().optional(),
      notes: z.string().optional(),
    });
    const payload = schema.parse(req.body);

    const record = await prisma.rfqVendorQuote.upsert({
      where: { rfqLineId_vendorId: { rfqLineId: payload.rfqLineId, vendorId: payload.vendorId } },
      update: { quotedPrice: payload.quotedPrice, leadTimeDays: payload.leadTimeDays, notes: payload.notes },
      create: { ...payload, tenantId, rfqId: rfq.id },
    });
    res.status(201).json(record);
  })
);

/** Marks the winning quote(s) - the ones that will be converted into a PO. */
router.post(
  "/rfqs/:id/select",
  requirePermission("Procurement.Rfq.Approve"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const rfq = await prisma.rfq.findFirst({ where: { id: req.params.id, tenantId } });
    if (!rfq) throw ApiError.notFound();

    const schema = z.object({ quoteIds: z.array(z.string().uuid()).min(1) });
    const { quoteIds } = schema.parse(req.body);

    await prisma.$transaction(async (tx) => {
      const quotes = await tx.rfqVendorQuote.findMany({ where: { id: { in: quoteIds }, tenantId, rfqId: rfq.id } });
      if (quotes.length !== quoteIds.length) throw ApiError.badRequest("One or more quotes not found on this RFQ");
      // A line can only have one winner, so clear any prior selection on the same lines first.
      const lineIds = quotes.map((q) => q.rfqLineId);
      await tx.rfqVendorQuote.updateMany({ where: { rfqLineId: { in: lineIds } }, data: { isSelected: false } });
      await tx.rfqVendorQuote.updateMany({ where: { id: { in: quoteIds } }, data: { isSelected: true } });
    });

    const record = await prisma.rfq.findUnique({
      where: { id: rfq.id },
      include: { lines: { include: { quotes: { include: { vendor: true } } } } },
    });
    res.json(record);
  })
);

/**
 * Converts every selected quote on this RFQ into purchase orders - one PO
 * per vendor, since a PO belongs to a single vendor. Closes the RFQ once
 * converted.
 */
router.post(
  "/rfqs/:id/convert-to-po",
  requirePermission("Procurement.Rfq.Approve"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid(), branchId: z.string().uuid() });
    const { companyId, branchId } = schema.parse(req.body);

    const rfq = await prisma.rfq.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: { include: { quotes: { where: { isSelected: true } } } } },
    });
    if (!rfq) throw ApiError.notFound();

    const selectedLines = rfq.lines.filter((l) => l.quotes.length > 0);
    if (selectedLines.length === 0) throw ApiError.badRequest("No selected quotes to convert - call /select first");

    const byVendor = new Map<string, typeof selectedLines>();
    for (const line of selectedLines) {
      const vendorId = line.quotes[0].vendorId;
      byVendor.set(vendorId, [...(byVendor.get(vendorId) ?? []), line]);
    }

    const createdPOs = await prisma.$transaction(async (tx) => {
      const pos: any[] = [];
      for (const [vendorId, lines] of byVendor) {
        const poLineInputs = lines.map((line) => ({
          itemId: line.itemId,
          qty: Number(line.qty),
          uomId: line.uomId,
          unitPrice: Number(line.quotes[0].quotedPrice),
          sourceRfqLineId: line.id,
        }));
        // RFQ-derived POs default to Vatable with no header discount - the
        // per-line tax still comes through if a line has its own taxId;
        // see computePoLineAmounts for the shared math with manual POs.
        const { lines: computedLines, totalAmount } = await computePoLineAmounts(
          tx,
          tenantId,
          { taxMode: "Vatable" },
          poLineInputs
        );
        const poNo = await nextDocumentNumber(tx, { tenantId, companyId, moduleCode: "PurchaseOrder", defaultPrefix: "PO" });
        const po = await tx.purchaseOrder.create({
          data: {
            tenantId,
            poNo,
            vendorId,
            branchId,
            totalAmount,
            lines: { create: computedLines.map((l) => ({ ...l, tenantId })) },
          },
          include: { lines: true },
        });
        pos.push(po);
      }
      await tx.rfq.update({ where: { id: rfq.id }, data: { status: "Closed" } });
      return pos;
    });

    res.status(201).json({ rfqId: rfq.id, purchaseOrders: createdPOs });
  })
);

// --- Purchase Orders ---------------------------------------------------------
const poLineSchema = z.object({
  itemId: z.string().uuid(),
  qty: z.number().positive(),
  uomId: z.string().uuid(),
  unitPrice: z.number().nonnegative(),
  taxId: z.string().uuid().optional(),
  discountPct: z.number().min(0).max(100).optional(),
  discountAmount: z.number().nonnegative().optional(),
  focQty: z.number().nonnegative().default(0),
  // Accepts either a real boolean or the "true"/"false" string a plain HTML
  // <select> sends, since the frontend's generic line-field renderer only
  // knows text/number/select/date inputs (see DocFieldConfig) - there's no
  // dedicated checkbox type, so this is modeled there as a Yes/No select.
  isFocLine: z.preprocess((v) => v === true || v === "true", z.boolean()).default(false),
  instructions: z.string().optional(),
  sourceMrId: z.string().uuid().optional(),
  sourceMrLineId: z.string().uuid().optional(),
});

// Shared header field set for both create and edit - every new field the
// user asked for on the PO header, all optional so existing behavior
// (a bare vendor/branch/lines PO) still works unchanged.
const poHeaderSchema = z.object({
  taxMode: z.enum(["Vatable", "Exempt"]).default("Vatable"),
  currencyId: z.string().uuid().optional(),
  exchangeRate: z.number().positive().default(1),
  discountPct: z.number().min(0).max(100).optional(),
  discountAmount: z.number().nonnegative().optional(),
  paymentTermsId: z.string().uuid().optional(),
  deliveryInstructions: z.string().optional(),
  requiredDate: z.coerce.date().optional(),
  validityDate: z.coerce.date().optional(),
  shipmentTypeId: z.string().uuid().optional(),
  shippingTerms: z.string().optional(),
});

router.post(
  "/purchase-orders",
  requirePermission("Procurement.PurchaseOrder.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = poHeaderSchema.extend({
      companyId: z.string().uuid(),
      vendorId: z.string().uuid(),
      branchId: z.string().uuid(),
      poDate: z.coerce.date().optional(),
      lines: z.array(poLineSchema).min(1),
    });
    const payload = schema.parse(req.body);
    const { lines: computedLines, totalAmount } = await computePoLineAmounts(
      prisma,
      tenantId,
      { taxMode: payload.taxMode, discountPct: payload.discountPct, discountAmount: payload.discountAmount },
      payload.lines
    );

    const record = await prisma.$transaction(async (tx) => {
      const poNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId: payload.companyId,
        moduleCode: "PurchaseOrder",
        defaultPrefix: "PO",
      });
      return tx.purchaseOrder.create({
        data: {
          tenantId,
          poNo,
          vendorId: payload.vendorId,
          branchId: payload.branchId,
          ...(payload.poDate ? { poDate: payload.poDate } : {}),
          taxMode: payload.taxMode,
          currencyId: payload.currencyId,
          exchangeRate: payload.exchangeRate,
          discountPct: payload.discountPct,
          discountAmount: payload.discountAmount,
          paymentTermsId: payload.paymentTermsId,
          deliveryInstructions: payload.deliveryInstructions,
          requiredDate: payload.requiredDate,
          validityDate: payload.validityDate,
          shipmentTypeId: payload.shipmentTypeId,
          shippingTerms: payload.shippingTerms,
          totalAmount,
          lines: { create: computedLines.map((l) => ({ ...l, tenantId })) },
        },
        include: { lines: true },
      });
    });

    res.status(201).json(record);
  })
);

router.get(
  "/purchase-orders",
  requirePermission("Procurement.PurchaseOrder.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.vendorId) where.vendorId = req.query.vendorId;
    const items = await prisma.purchaseOrder.findMany({
      where,
      include: { lines: true, vendor: true, branch: true, currency: true, paymentTerms: true, shipmentType: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: items });
  })
);

router.get(
  "/purchase-orders/:id",
  requirePermission("Procurement.PurchaseOrder.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.purchaseOrder.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        lines: { include: { item: true, uom: true, tax: true } },
        vendor: true,
        // Nested company for the print letterhead - see the same comment on
        // GET /material-requests/:id above.
        branch: { include: { company: true } },
        grns: true,
        currency: true,
        paymentTerms: true,
        shipmentType: true,
      },
    });
    if (!record) throw ApiError.notFound();
    res.json(record);
  })
);

router.put(
  "/purchase-orders/:id",
  requirePermission("Procurement.PurchaseOrder.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    if (existing.status !== "Draft") {
      throw ApiError.badRequest(`Cannot edit a PO in status ${existing.status} - only Draft POs can be edited`);
    }

    const schema = poHeaderSchema.extend({
      vendorId: z.string().uuid(),
      branchId: z.string().uuid(),
      poDate: z.coerce.date().optional(),
      lines: z.array(poLineSchema).min(1),
    });
    const payload = schema.parse(req.body);
    const { lines: computedLines, totalAmount } = await computePoLineAmounts(
      prisma,
      tenantId,
      { taxMode: payload.taxMode, discountPct: payload.discountPct, discountAmount: payload.discountAmount },
      payload.lines
    );

    const record = await prisma.$transaction(async (tx) => {
      // Same replace-the-set approach as Material Request edit: safe here
      // because a Draft PO's lines can't yet be referenced by a GRN.
      await tx.purchaseOrderLine.deleteMany({ where: { poId: existing.id } });
      return tx.purchaseOrder.update({
        where: { id: existing.id },
        data: {
          vendorId: payload.vendorId,
          branchId: payload.branchId,
          ...(payload.poDate ? { poDate: payload.poDate } : {}),
          taxMode: payload.taxMode,
          currencyId: payload.currencyId,
          exchangeRate: payload.exchangeRate,
          discountPct: payload.discountPct,
          discountAmount: payload.discountAmount,
          paymentTermsId: payload.paymentTermsId,
          deliveryInstructions: payload.deliveryInstructions,
          requiredDate: payload.requiredDate,
          validityDate: payload.validityDate,
          shipmentTypeId: payload.shipmentTypeId,
          shippingTerms: payload.shippingTerms,
          totalAmount,
          lines: { create: computedLines.map((l) => ({ ...l, tenantId })) },
        },
        include: { lines: true },
      });
    });

    await writeAuditLog(prisma, {
      tenantId,
      userId: req.user?.userId,
      moduleCode: "Procurement.PurchaseOrder",
      recordTable: "purchase_orders",
      recordId: record.id,
      action: "Edited",
      oldValue: existing,
      newValue: payload,
    });

    res.json(record);
  })
);

router.delete(
  "/purchase-orders/:id",
  requirePermission("Procurement.PurchaseOrder.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    if (existing.status !== "Draft") {
      throw ApiError.badRequest(`Cannot delete a PO in status ${existing.status} - only Draft POs can be deleted`);
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.purchaseOrderLine.deleteMany({ where: { poId: existing.id } });
        await tx.purchaseOrder.delete({ where: { id: existing.id } });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2003" || err.code === "P2014")) {
        throw ApiError.badRequest("This purchase order is referenced elsewhere and can't be deleted.");
      }
      throw err;
    }

    await writeAuditLog(prisma, {
      tenantId,
      userId: req.user?.userId,
      moduleCode: "Procurement.PurchaseOrder",
      recordTable: "purchase_orders",
      recordId: req.params.id,
      action: "Deleted",
      oldValue: existing,
    });

    res.status(204).send();
  })
);

router.post(
  "/purchase-orders/:id/submit",
  requirePermission("Procurement.PurchaseOrder.Submit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    const record = await prisma.purchaseOrder.update({ where: { id: existing.id }, data: { status: "Submitted" } });
    await triggerApproval(prisma, {
      tenantId,
      moduleCode: "Procurement.PurchaseOrder",
      recordId: record.id,
      amount: Number(record.totalAmount),
    });
    await writeAuditLog(prisma, {
      tenantId,
      userId: req.user?.userId,
      moduleCode: "Procurement.PurchaseOrder",
      recordTable: "purchase_orders",
      recordId: record.id,
      action: "Submitted",
    });
    res.json(record);
  })
);

router.post(
  "/purchase-orders/:id/approve",
  requirePermission("Procurement.PurchaseOrder.Approve"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    const record = await prisma.purchaseOrder.update({
      where: { id: existing.id },
      data: { status: "Approved", approvalStatus: "Approved" },
    });
    await writeAuditLog(prisma, {
      tenantId,
      userId: req.user?.userId,
      moduleCode: "Procurement.PurchaseOrder",
      recordTable: "purchase_orders",
      recordId: record.id,
      action: "Approved",
    });
    res.json(record);
  })
);

/**
 * Extends (or otherwise updates) a PO's validity date after the fact.
 * Distinct from the normal Draft-only PUT /purchase-orders/:id edit route
 * because validity legitimately needs adjusting on POs that are already
 * Submitted/Approved - gated behind the Approve permission rather than Edit
 * so it's the same "authorized user" tier the user asked for.
 */
router.post(
  "/purchase-orders/:id/extend-validity",
  requirePermission("Procurement.PurchaseOrder.Approve"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ validityDate: z.coerce.date() });
    const { validityDate } = schema.parse(req.body);
    const existing = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    if (existing.status === "Cancelled") {
      throw ApiError.badRequest("Cannot change the validity date of a Cancelled purchase order");
    }
    const record = await prisma.purchaseOrder.update({
      where: { id: existing.id },
      data: { validityDate },
    });
    await writeAuditLog(prisma, {
      tenantId,
      userId: req.user?.userId,
      moduleCode: "Procurement.PurchaseOrder",
      recordTable: "purchase_orders",
      recordId: record.id,
      action: "ValidityExtended",
      oldValue: { validityDate: existing.validityDate },
      newValue: { validityDate },
    });
    res.json(record);
  })
);

// --- GRN (Goods Receipt Note) ------------------------------------------------
const grnLineSchema = z.object({
  poLineId: z.string().uuid().optional(),
  itemId: z.string().uuid(),
  receivedQty: z.number().positive(),
  acceptedQty: z.number().nonnegative(),
  rejectedQty: z.number().nonnegative().default(0),
  batchNo: z.string().optional(),
  expiryDate: z.coerce.date().optional(),
  unitCost: z.number().nonnegative().optional(),
});

router.post(
  "/grns",
  requirePermission("Procurement.Grn.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      poId: z.string().uuid().optional(),
      vendorId: z.string().uuid(),
      branchId: z.string().uuid(),
      warehouseId: z.string().uuid(),
      lines: z.array(grnLineSchema).min(1),
    });
    const payload = schema.parse(req.body);

    for (const l of payload.lines) {
      if (l.acceptedQty + l.rejectedQty > l.receivedQty + 1e-9) {
        throw ApiError.badRequest("accepted + rejected quantity cannot exceed received quantity", l);
      }
    }

    if (payload.poId) {
      const po = await prisma.purchaseOrder.findFirst({ where: { id: payload.poId, tenantId } });
      if (!po) throw ApiError.badRequest("poId not found");
      const expired = po.validityDate && po.validityDate.getTime() < Date.now();
      // An authorized user (Approve permission) can still push a GRN through
      // on an expired PO by first calling extend-validity - this check just
      // stops it happening silently for everyone else.
      if (expired && !hasPermission(req, "Procurement.PurchaseOrder.Approve")) {
        throw ApiError.badRequest(
          `This purchase order's validity date has passed (${po.validityDate!.toISOString().slice(0, 10)}) - ask an authorized user to extend it before receiving against it.`
        );
      }
    }

    const record = await prisma.$transaction(async (tx) => {
      const grnNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId: payload.companyId,
        moduleCode: "GRN",
        defaultPrefix: "GRN",
      });
      return tx.grn.create({
        data: {
          tenantId,
          grnNo,
          poId: payload.poId,
          vendorId: payload.vendorId,
          branchId: payload.branchId,
          warehouseId: payload.warehouseId,
          lines: { create: payload.lines.map((l) => ({ ...l, tenantId })) },
        },
        include: { lines: true },
      });
    });

    res.status(201).json(record);
  })
);

router.get(
  "/grns",
  requirePermission("Procurement.Grn.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.poId) where.poId = req.query.poId;
    const items = await prisma.grn.findMany({ where, include: { lines: true }, orderBy: { createdAt: "desc" } });
    res.json({ data: items });
  })
);

router.get(
  "/grns/:id",
  requirePermission("Procurement.Grn.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.grn.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: { include: { item: true, poLine: true } } },
    });
    if (!record) throw ApiError.notFound();
    res.json(record);
  })
);

/**
 * Posts the GRN: appends stock_ledger rows for each accepted line (weighted
 * average costing), and books a provisional GL entry Dr Inventory Asset /
 * Cr GRN Clearing (accrual) - matching BRD 5.9 "GRN accrual", settled later
 * when the purchase invoice is matched and posted.
 */
router.post(
  "/grns/:id/post",
  requirePermission("Procurement.Grn.Post"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid() });
    const { companyId } = schema.parse(req.body);

    const grn = await prisma.grn.findFirst({ where: { id: req.params.id, tenantId } });
    if (!grn) throw ApiError.notFound();
    if (grn.status !== "Draft") throw ApiError.badRequest(`GRN already ${grn.status}`);

    const linesWithDetail = await prisma.grnLine.findMany({
      where: { grnId: grn.id },
      include: { item: { include: { glMapping: true } }, poLine: true },
    });

    await prisma.$transaction(async (tx) => {
      let totalValue = 0;
      const grnClearing = await resolveCoaByCode(tx, tenantId, companyId, "GRN-CLEARING");

      for (const line of linesWithDetail) {
        if (Number(line.acceptedQty) <= 0) continue;
        const unitCost = line.unitCost && Number(line.unitCost) > 0
          ? Number(line.unitCost)
          : line.poLine
          ? Number(line.poLine.unitPrice)
          : 0;

        await postStockMovement(tx, {
          tenantId,
          itemId: line.itemId,
          warehouseId: grn.warehouseId,
          batchNo: line.batchNo,
          expiryDate: line.expiryDate,
          qtyIn: Number(line.acceptedQty),
          unitCost,
          sourceModule: "Procurement",
          sourceDocType: "GRN",
          sourceDocId: grn.id,
        });

        totalValue += Number(line.acceptedQty) * unitCost;
      }

      if (grnClearing && totalValue > 0) {
        // Simplified: post the whole GRN value against a single generic
        // inventory control account, since items may span multiple GL
        // mappings - a per-line posting_rule engine is the natural Phase 2
        // upgrade (ERD blueprint section 12 "Posting engine").
        const inventoryControl = await resolveCoaByCode(tx, tenantId, companyId, "INVENTORY-CONTROL");
        if (inventoryControl) {
          await postJournal(tx, {
            tenantId,
            companyId,
            sourceModule: "Procurement",
            sourceDocId: grn.id,
            lines: [
              { accountId: inventoryControl.id, debit: totalValue },
              { accountId: grnClearing.id, credit: totalValue },
            ],
          });
        } else {
          await recordPostingException(tx, {
            tenantId,
            sourceModule: "Procurement",
            sourceDocId: grn.id,
            exceptionType: "Missing GL",
            message: "INVENTORY-CONTROL account not configured for this company",
          });
        }
      } else if (!grnClearing && totalValue > 0) {
        await recordPostingException(tx, {
          tenantId,
          sourceModule: "Procurement",
          sourceDocId: grn.id,
          exceptionType: "Missing GL",
          message: "GRN-CLEARING account not configured for this company",
        });
      }

      await tx.grn.update({ where: { id: grn.id }, data: { status: "Posted", qcStatus: "Accepted" } });

      if (grn.poId) {
        const poLines = await tx.purchaseOrderLine.findMany({ where: { poId: grn.poId } });
        const grnLines = await tx.grnLine.findMany({ where: { grn: { poId: grn.poId } } });
        const fullyReceived = poLines.every((pl) => {
          const receivedForLine = grnLines
            .filter((gl) => gl.poLineId === pl.id)
            .reduce((s, gl) => s + Number(gl.acceptedQty), 0);
          return receivedForLine >= Number(pl.qty) - 1e-6;
        });
        await tx.purchaseOrder.update({
          where: { id: grn.poId },
          data: { status: fullyReceived ? "Closed" : "Partially Received" },
        });
      }
    });

    const updated = await prisma.grn.findUnique({ where: { id: grn.id }, include: { lines: true } });
    res.json(updated);
  })
);

// --- Goods Return (GRV) - return goods to a vendor -----------------------------
// Per Screen Spec: "Return goods to vendor ... return qty cannot exceed
// available accepted qty. Posts negative stock and debit note if invoiced."
const goodsReturnLineSchema = z.object({
  grnLineId: z.string().uuid().optional(),
  itemId: z.string().uuid(),
  batchNo: z.string().optional(),
  returnQty: z.number().positive(),
  unitCost: z.number().nonnegative().optional(),
  reason: z.string().optional(),
});

router.post(
  "/goods-returns",
  requirePermission("Procurement.GoodsReturn.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      grnId: z.string().uuid().optional(),
      vendorId: z.string().uuid(),
      branchId: z.string().uuid(),
      warehouseId: z.string().uuid(),
      reason: z.string().optional(),
      lines: z.array(goodsReturnLineSchema).min(1),
    });
    const payload = schema.parse(req.body);

    // Validate: return qty (this request + anything already returned against
    // the same GRN line) cannot exceed that GRN line's accepted qty.
    for (const line of payload.lines) {
      if (!line.grnLineId) continue;
      const grnLine = await prisma.grnLine.findFirst({ where: { id: line.grnLineId, tenantId } });
      if (!grnLine) throw ApiError.badRequest(`GRN line ${line.grnLineId} not found`);
      const alreadyReturned = await prisma.goodsReturnLine.aggregate({
        where: { tenantId, grnLineId: line.grnLineId, goodsReturn: { status: { not: "Cancelled" } } },
        _sum: { returnQty: true },
      });
      const returnedSoFar = Number(alreadyReturned._sum.returnQty ?? 0);
      if (returnedSoFar + line.returnQty > Number(grnLine.acceptedQty) + 1e-9) {
        throw ApiError.badRequest(
          `Return qty for item exceeds available accepted qty (accepted ${grnLine.acceptedQty}, already returned ${returnedSoFar})`
        );
      }
    }

    const record = await prisma.$transaction(async (tx) => {
      const returnNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId: payload.companyId,
        moduleCode: "GoodsReturn",
        defaultPrefix: "GRV",
      });
      return tx.goodsReturn.create({
        data: {
          tenantId,
          returnNo,
          grnId: payload.grnId,
          vendorId: payload.vendorId,
          branchId: payload.branchId,
          warehouseId: payload.warehouseId,
          reason: payload.reason,
          lines: { create: payload.lines.map((l) => ({ ...l, tenantId })) },
        },
        include: { lines: true },
      });
    });

    res.status(201).json(record);
  })
);

router.get(
  "/goods-returns",
  requirePermission("Procurement.GoodsReturn.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.vendorId) where.vendorId = req.query.vendorId;
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.goodsReturn.findMany({ where, include: { lines: true }, orderBy: { createdAt: "desc" } });
    res.json({ data: items });
  })
);

router.get(
  "/goods-returns/:id",
  requirePermission("Procurement.GoodsReturn.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.goodsReturn.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: { include: { item: true, grnLine: true } }, vendor: true },
    });
    if (!record) throw ApiError.notFound();
    res.json(record);
  })
);

/**
 * Posts the goods return: appends a negative stock movement (qtyOut) at the
 * item's current average cost for each line, then - if the source GRN was
 * already matched to a posted purchase invoice - raises and posts a debit
 * note against the vendor for the returned value (Dr Accounts Payable /
 * Cr GRN Clearing), reducing what's owed to them.
 */
router.post(
  "/goods-returns/:id/post",
  requirePermission("Procurement.GoodsReturn.Post"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid() });
    const { companyId } = schema.parse(req.body);

    const goodsReturn = await prisma.goodsReturn.findFirst({ where: { id: req.params.id, tenantId } });
    if (!goodsReturn) throw ApiError.notFound();
    if (goodsReturn.status !== "Draft") throw ApiError.badRequest(`Goods return already ${goodsReturn.status}`);

    const linesWithDetail = await prisma.goodsReturnLine.findMany({
      where: { goodsReturnId: goodsReturn.id },
      include: { item: true },
    });

    // If the source GRN is already covered by a posted purchase invoice, the
    // return needs a debit note rather than just a stock reversal.
    const invoicedGrnBridge = goodsReturn.grnId
      ? await prisma.purchaseInvoiceGrn.findFirst({
          where: { grnId: goodsReturn.grnId, tenantId, purchaseInvoice: { postingStatus: "Posted" } },
          include: { purchaseInvoice: true },
        })
      : null;

    const result = await prisma.$transaction(async (tx) => {
      let totalValue = 0;
      for (const line of linesWithDetail) {
        const unitCost =
          line.unitCost && Number(line.unitCost) > 0
            ? Number(line.unitCost)
            : line.item.averageCost
            ? Number(line.item.averageCost)
            : 0;

        await postStockMovement(tx, {
          tenantId,
          itemId: line.itemId,
          warehouseId: goodsReturn.warehouseId,
          batchNo: line.batchNo,
          qtyOut: Number(line.returnQty),
          sourceModule: "Procurement",
          sourceDocType: "GoodsReturn",
          sourceDocId: goodsReturn.id,
        });

        totalValue += Number(line.returnQty) * unitCost;
      }

      await tx.goodsReturn.update({ where: { id: goodsReturn.id }, data: { status: "Posted" } });

      if (!invoicedGrnBridge || totalValue <= 0) {
        return { debitNote: null };
      }

      const debitNoteNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId,
        moduleCode: "VendorDebitNote",
        defaultPrefix: "DN",
      });
      const debitNote = await tx.vendorDebitNote.create({
        data: {
          tenantId,
          debitNoteNo,
          vendorId: goodsReturn.vendorId,
          goodsReturnId: goodsReturn.id,
          purchaseInvoiceId: invoicedGrnBridge.purchaseInvoiceId,
          amount: totalValue,
        },
      });

      const grnClearing = await resolveCoaByCode(tx, tenantId, companyId, "GRN-CLEARING");
      const vendor = await tx.vendor.findUnique({ where: { id: goodsReturn.vendorId } });
      const apControl =
        (vendor?.payableGlId && (await tx.chartOfAccount.findUnique({ where: { id: vendor.payableGlId } }))) ||
        (await resolveCoaByCode(tx, tenantId, companyId, "AP-CONTROL"));

      if (grnClearing && apControl) {
        await postJournal(tx, {
          tenantId,
          companyId,
          sourceModule: "Procurement",
          sourceDocId: debitNote.id,
          lines: [
            { accountId: apControl.id, debit: totalValue },
            { accountId: grnClearing.id, credit: totalValue },
          ],
        });
        await tx.vendorDebitNote.update({ where: { id: debitNote.id }, data: { postingStatus: "Posted" } });
      } else {
        await recordPostingException(tx, {
          tenantId,
          sourceModule: "Procurement",
          sourceDocId: debitNote.id,
          exceptionType: "Missing GL",
          message: "GRN-CLEARING or AP-CONTROL account not configured for this company",
        });
      }

      return { debitNote };
    });

    const updated = await prisma.goodsReturn.findUnique({ where: { id: goodsReturn.id }, include: { lines: true } });
    res.json({ ...updated, debitNote: result.debitNote });
  })
);

// --- Vendor Debit Notes (read-only API - created automatically by
// goods-returns/:id/post when the returned goods were already invoiced) ----
router.get(
  "/vendor-debit-notes",
  requirePermission("Procurement.VendorDebitNote.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.vendorId) where.vendorId = req.query.vendorId;
    const items = await prisma.vendorDebitNote.findMany({ where, orderBy: { createdAt: "desc" } });
    res.json({ data: items });
  })
);

// --- Purchase Invoices --------------------------------------------------------
router.post(
  "/purchase-invoices",
  requirePermission("Procurement.PurchaseInvoice.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      vendorId: z.string().uuid(),
      invoiceNo: z.string().min(1),
      invoiceDate: z.coerce.date().optional(),
      gross: z.number().nonnegative(),
      tax: z.number().nonnegative().default(0),
      grnIds: z.array(z.string().uuid()).min(1),
    });
    const payload = schema.parse(req.body);
    const net = payload.gross + payload.tax;

    const duplicate = await prisma.purchaseInvoice.findFirst({
      where: { tenantId, vendorId: payload.vendorId, invoiceNo: payload.invoiceNo },
    });
    if (duplicate) throw ApiError.conflict("Duplicate vendor invoice number");

    const record = await prisma.purchaseInvoice.create({
      data: {
        tenantId,
        vendorId: payload.vendorId,
        invoiceNo: payload.invoiceNo,
        invoiceDate: payload.invoiceDate,
        gross: payload.gross,
        tax: payload.tax,
        net,
        grns: { create: payload.grnIds.map((grnId) => ({ tenantId, grnId })) },
      },
      include: { grns: { include: { grn: { include: { lines: true } } } } },
    });

    res.status(201).json(record);
  })
);

router.get(
  "/purchase-invoices",
  requirePermission("Procurement.PurchaseInvoice.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const items = await prisma.purchaseInvoice.findMany({
      where: { tenantId },
      include: { grns: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: items });
  })
);

/**
 * Posts the purchase invoice after a three-way match (PO price/qty vs GRN
 * accepted qty vs invoice amount, within TOLERANCE_PCT) - BRD 5.4: "Purchase
 * invoice with PO-GRN-invoice three-way matching, amount/quantity tolerance
 * ... and GL posting." Books Dr GRN Clearing / Cr Accounts Payable.
 */
router.post(
  "/purchase-invoices/:id/post",
  requirePermission("Procurement.PurchaseInvoice.Post"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid() });
    const { companyId } = schema.parse(req.body);

    const invoice = await prisma.purchaseInvoice.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        vendor: true,
        grns: { include: { grn: { include: { lines: { include: { poLine: true } } } } } },
      },
    });
    if (!invoice) throw ApiError.notFound();
    if (invoice.postingStatus === "Posted") throw ApiError.badRequest("Invoice already posted");

    const expectedAmount = invoice.grns.reduce((sum, bridge) => {
      const linesTotal = bridge.grn.lines.reduce((s, l) => {
        const price = l.poLine ? Number(l.poLine.unitPrice) : Number(l.unitCost ?? 0);
        return s + Number(l.acceptedQty) * price;
      }, 0);
      return sum + linesTotal;
    }, 0);

    // Was a hardcoded 2% constant - now reads the company's own tolerance
    // from the Company Policies screen (falls back to the same 2% if the
    // admin hasn't set one, so existing behaviour doesn't change silently).
    // Value is stored as a plain percentage (2 = 2%), not a fraction.
    const tolerancePolicy = await resolvePolicy(prisma, {
      tenantId,
      companyId,
      policyType: "PoGrnInvoiceTolerancePct",
      defaultAllow: true,
      defaultValue: 2,
    });
    const tolerancePct = (tolerancePolicy.value ?? 2) / 100;

    const variance = expectedAmount === 0 ? 0 : Math.abs(Number(invoice.gross) - expectedAmount) / expectedAmount;
    if (variance > tolerancePct) {
      throw ApiError.badRequest(
        `Invoice amount ${invoice.gross} exceeds tolerance vs matched GRN value ${expectedAmount.toFixed(2)} (variance ${(variance * 100).toFixed(1)}%)`,
        { expectedAmount, invoiceGross: invoice.gross, tolerancePct }
      );
    }

    // Was never enforced anywhere before - defaults to allow=true so
    // nothing changes for a company until it's explicitly restricted from
    // the Company Policies screen.
    const vendorCreditPolicy = await resolvePolicy(prisma, {
      tenantId,
      companyId,
      policyType: "PurchaseAboveVendorCreditLimit",
      defaultAllow: true,
      defaultValue: null,
    });
    if (!vendorCreditPolicy.allow && invoice.vendor.creditLimit) {
      const postedInvoices = await prisma.purchaseInvoice.findMany({
        where: { tenantId, vendorId: invoice.vendorId, postingStatus: "Posted" },
        include: { payments: true },
      });
      const currentOutstanding = postedInvoices.reduce((sum, inv) => {
        const applied = inv.payments.reduce((s, p) => s + Number(p.appliedAmount), 0);
        return sum + (Number(inv.net) - applied);
      }, 0);
      const projected = currentOutstanding + Number(invoice.net);
      if (projected > Number(invoice.vendor.creditLimit)) {
        throw ApiError.badRequest(
          `Posting this invoice would put ${invoice.vendor.name}'s outstanding balance at ${projected.toFixed(2)}, above their credit limit of ${Number(invoice.vendor.creditLimit).toFixed(2)}.`,
          { projected, creditLimit: Number(invoice.vendor.creditLimit) }
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      const grnClearing = await resolveCoaByCode(tx, tenantId, companyId, "GRN-CLEARING");
      const apControl =
        (invoice.vendor.payableGlId && (await tx.chartOfAccount.findUnique({ where: { id: invoice.vendor.payableGlId } }))) ||
        (await resolveCoaByCode(tx, tenantId, companyId, "AP-CONTROL"));

      if (grnClearing && apControl) {
        await postJournal(tx, {
          tenantId,
          companyId,
          sourceModule: "Procurement",
          sourceDocId: invoice.id,
          lines: [
            { accountId: grnClearing.id, debit: Number(invoice.net) },
            { accountId: apControl.id, credit: Number(invoice.net) },
          ],
        });
      } else {
        await recordPostingException(tx, {
          tenantId,
          sourceModule: "Procurement",
          sourceDocId: invoice.id,
          exceptionType: "Missing GL",
          message: "GRN-CLEARING or AP-CONTROL account not configured for this company",
        });
      }

      await tx.purchaseInvoice.update({ where: { id: invoice.id }, data: { postingStatus: "Posted" } });
    });

    const updated = await prisma.purchaseInvoice.findUnique({ where: { id: invoice.id } });
    res.json(updated);
  })
);

// --- Vendor Payments -----------------------------------------------------------
router.post(
  "/vendor-payments",
  requirePermission("Procurement.VendorPayment.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      vendorId: z.string().uuid(),
      amount: z.number().positive(),
      paymentMethodId: z.string().uuid(),
      bankAccountId: z.string().uuid().optional(),
      mode: z.enum(["Invoice", "Advance"]).default("Invoice"),
      invoices: z.array(z.object({ purchaseInvoiceId: z.string().uuid(), appliedAmount: z.number().positive() })).optional(),
      chequeNo: z.string().optional(),
      chequeDate: z.coerce.date().optional(),
    });
    const payload = schema.parse(req.body);

    if (payload.mode === "Invoice") {
      if (!payload.invoices || payload.invoices.length === 0) {
        throw ApiError.badRequest("Invoice-mode payment needs at least one invoice to apply against");
      }
      const appliedTotal = payload.invoices.reduce((s, i) => s + i.appliedAmount, 0);
      if (Math.abs(appliedTotal - payload.amount) > 0.01) {
        throw ApiError.badRequest("Sum of applied amounts must equal the payment amount");
      }
    } else if (payload.invoices && payload.invoices.length > 0) {
      throw ApiError.badRequest("Advance-mode payment cannot be applied against invoices");
    }

    const record = await prisma.$transaction(async (tx) => {
      const paymentNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId: payload.companyId,
        moduleCode: "VendorPayment",
        defaultPrefix: "VP",
      });
      const paymentMethod = await tx.paymentMethod.findUnique({ where: { id: payload.paymentMethodId } });
      if (paymentMethod?.type === "Cheque" && !payload.chequeNo) {
        throw ApiError.badRequest("chequeNo is required when paying by a Cheque-type payment method");
      }
      return tx.vendorPayment.create({
        data: {
          tenantId,
          paymentNo,
          vendorId: payload.vendorId,
          amount: payload.amount,
          paymentMethodId: payload.paymentMethodId,
          bankAccountId: payload.bankAccountId,
          mode: payload.mode,
          chequeNo: payload.chequeNo,
          chequeDate: payload.chequeDate,
          chequeStatus: paymentMethod?.type === "Cheque" ? "Issued" : undefined,
          invoices: {
            create: (payload.invoices ?? []).map((i) => ({ tenantId, purchaseInvoiceId: i.purchaseInvoiceId, appliedAmount: i.appliedAmount })),
          },
        },
        include: { invoices: true },
      });
    });

    res.status(201).json(record);
  })
);

router.get(
  "/vendor-payments",
  requirePermission("Procurement.VendorPayment.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const items = await prisma.vendorPayment.findMany({ where: { tenantId }, include: { invoices: true }, orderBy: { paymentDate: "desc" } });
    res.json({ data: items });
  })
);

/**
 * Posts the payment. Invoice mode: Dr Accounts Payable / Cr Bank-Cash, per
 * BRD 5.4. Advance mode: Dr Vendor Advance / Cr Bank-Cash, per BRD 5.9
 * "vendor advance" - a prepayment sitting as an asset until applied against
 * a future invoice.
 */
router.post(
  "/vendor-payments/:id/post",
  requirePermission("Procurement.VendorPayment.Post"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid() });
    const { companyId } = schema.parse(req.body);

    const payment = await prisma.vendorPayment.findFirst({
      where: { id: req.params.id, tenantId },
      include: { vendor: true, bankAccount: true },
    });
    if (!payment) throw ApiError.notFound();
    if (payment.postingStatus === "Posted") throw ApiError.badRequest("Payment already posted");

    await prisma.$transaction(async (tx) => {
      const debitAccount =
        payment.mode === "Advance"
          ? await resolveCoaByCode(tx, tenantId, companyId, "VENDOR-ADVANCE")
          : (payment.vendor.payableGlId && (await tx.chartOfAccount.findUnique({ where: { id: payment.vendor.payableGlId } }))) ||
            (await resolveCoaByCode(tx, tenantId, companyId, "AP-CONTROL"));
      const debitAccountLabel = payment.mode === "Advance" ? "VENDOR-ADVANCE" : "AP-CONTROL";
      const bankAccountId =
        payment.bankAccount?.accountId ??
        (await resolveCoaByCode(tx, tenantId, companyId, "CASH-CONTROL"))?.id;

      if (debitAccount && bankAccountId) {
        await postJournal(tx, {
          tenantId,
          companyId,
          sourceModule: "Procurement",
          sourceDocId: payment.id,
          lines: [
            { accountId: debitAccount.id, debit: Number(payment.amount) },
            { accountId: bankAccountId, credit: Number(payment.amount) },
          ],
        });
      } else {
        await recordPostingException(tx, {
          tenantId,
          sourceModule: "Procurement",
          sourceDocId: payment.id,
          exceptionType: "Missing GL",
          message: `${debitAccountLabel} or bank/cash account not configured for this company`,
        });
      }

      await tx.vendorPayment.update({ where: { id: payment.id }, data: { postingStatus: "Posted" } });

      // Mark fully-paid invoices as such is left to a reporting view over
      // vendor_payment_invoices vs purchase_invoices.net for MVP.
    });

    const updated = await prisma.vendorPayment.findUnique({ where: { id: payment.id } });
    res.json(updated);
  })
);

// --- Purchase Reports ---------------------------------------------------------
// BRD "Reports" module's purchase slice, same rebuildable-from-transactions
// principle as the Inventory/Sales reports.

/** Spend by vendor over a date range, from posted purchase invoices. */
router.get(
  "/reports/vendor-spend",
  requirePermission("Procurement.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ fromDate: z.coerce.date(), toDate: z.coerce.date(), vendorId: z.string().uuid().optional() });
    const { fromDate, toDate, vendorId } = schema.parse(req.query);

    const invoices = await prisma.purchaseInvoice.findMany({
      where: {
        tenantId,
        postingStatus: "Posted",
        invoiceDate: { gte: fromDate, lte: toDate },
        ...(vendorId ? { vendorId } : {}),
      },
      include: { vendor: true },
    });

    const byVendor = new Map<string, { vendorId: string; vendorCode: string; vendorName: string; invoiceCount: number; gross: number; tax: number; net: number }>();
    for (const inv of invoices) {
      const entry = byVendor.get(inv.vendorId) ?? {
        vendorId: inv.vendorId,
        vendorCode: inv.vendor.code,
        vendorName: inv.vendor.name,
        invoiceCount: 0,
        gross: 0,
        tax: 0,
        net: 0,
      };
      entry.invoiceCount += 1;
      entry.gross += Number(inv.gross);
      entry.tax += Number(inv.tax);
      entry.net += Number(inv.net);
      byVendor.set(inv.vendorId, entry);
    }

    res.json({
      data: [...byVendor.values()].sort((a, b) => b.net - a.net),
      totalNet: invoices.reduce((s, i) => s + Number(i.net), 0),
    });
  })
);

/**
 * Purchase price variance: what was actually received (GrnLine.unitCost)
 * vs. what the PO agreed to (PurchaseOrderLine.unitPrice), per item -
 * catches vendors drifting prices up between PO and delivery. Only GRN
 * lines linked back to a PO line are counted (poLineId not null); direct/
 * unplanned GRNs have no PO price to compare against.
 */
router.get(
  "/reports/price-variance",
  requirePermission("Procurement.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      fromDate: z.coerce.date(),
      toDate: z.coerce.date(),
      vendorId: z.string().uuid().optional(),
      itemId: z.string().uuid().optional(),
    });
    const { fromDate, toDate, vendorId, itemId } = schema.parse(req.query);

    const lines = await prisma.grnLine.findMany({
      where: {
        tenantId,
        poLineId: { not: null },
        ...(itemId ? { itemId } : {}),
        grn: {
          tenantId,
          status: "Posted",
          grnDate: { gte: fromDate, lte: toDate },
          ...(vendorId ? { vendorId } : {}),
        },
      },
      include: { item: true, poLine: true },
    });

    const byItem = new Map<string, { itemId: string; itemCode: string; itemName: string; receivedQty: number; poValue: number; actualValue: number; variance: number }>();
    for (const line of lines) {
      if (!line.poLine) continue;
      const qty = Number(line.receivedQty);
      const poUnitPrice = Number(line.poLine.unitPrice);
      const actualUnitCost = Number(line.unitCost);
      const entry = byItem.get(line.itemId) ?? {
        itemId: line.itemId,
        itemCode: line.item.code,
        itemName: line.item.name,
        receivedQty: 0,
        poValue: 0,
        actualValue: 0,
        variance: 0,
      };
      entry.receivedQty += qty;
      entry.poValue += qty * poUnitPrice;
      entry.actualValue += qty * actualUnitCost;
      entry.variance = entry.actualValue - entry.poValue;
      byItem.set(line.itemId, entry);
    }

    const data = [...byItem.values()].sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
    res.json({ data, totalVariance: data.reduce((s, r) => s + r.variance, 0) });
  })
);

/**
 * Open pipeline: POs not yet fully received/closed, with ordered-vs-
 * received quantity per line, plus posted GRNs with no purchase invoice
 * against them yet (received but not yet billed).
 */
router.get(
  "/reports/po-pipeline",
  requirePermission("Procurement.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ branchId: z.string().uuid().optional(), vendorId: z.string().uuid().optional() });
    const { branchId, vendorId } = schema.parse(req.query);

    const openPOs = await prisma.purchaseOrder.findMany({
      where: {
        tenantId,
        status: { in: ["Submitted", "Approved", "Partially Received"] },
        ...(branchId ? { branchId } : {}),
        ...(vendorId ? { vendorId } : {}),
      },
      include: { vendor: true, lines: { include: { item: true } } },
    });

    const poIds = openPOs.map((po) => po.id);
    const grnLines = poIds.length
      ? await prisma.grnLine.findMany({ where: { tenantId, poLine: { poId: { in: poIds } } }, include: { poLine: true } })
      : [];
    const receivedByPoLine = new Map<string, number>();
    for (const gl of grnLines) {
      if (!gl.poLineId) continue;
      receivedByPoLine.set(gl.poLineId, (receivedByPoLine.get(gl.poLineId) ?? 0) + Number(gl.acceptedQty));
    }

    const now = Date.now();
    const pipeline = openPOs.map((po) => ({
      poId: po.id,
      poNo: po.poNo,
      vendorName: po.vendor.name,
      poDate: po.poDate,
      daysOpen: Math.floor((now - po.poDate.getTime()) / (1000 * 60 * 60 * 24)),
      status: po.status,
      totalAmount: Number(po.totalAmount),
      lines: po.lines.map((l) => ({
        itemCode: l.item.code,
        itemName: l.item.name,
        orderedQty: Number(l.qty),
        receivedQty: receivedByPoLine.get(l.id) ?? 0,
        pendingQty: Number(l.qty) - (receivedByPoLine.get(l.id) ?? 0),
      })),
    }));

    const pendingInvoiceGrns = await prisma.grn.findMany({
      where: {
        tenantId,
        status: "Posted",
        purchaseInvoices: { none: {} },
        ...(branchId ? { branchId } : {}),
        ...(vendorId ? { vendorId } : {}),
      },
      include: { vendor: true },
    });

    res.json({
      openPOs: pipeline,
      pendingInvoiceGrns: pendingInvoiceGrns.map((g) => ({
        grnId: g.id,
        grnNo: g.grnNo,
        vendorName: g.vendor.name,
        grnDate: g.grnDate,
        daysSinceReceipt: Math.floor((now - g.grnDate.getTime()) / (1000 * 60 * 60 * 24)),
      })),
    });
  })
);

export default router;
