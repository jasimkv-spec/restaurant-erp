import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { crudRouter } from "../../utils/crudFactory";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePermission } from "../../middleware/rbac";
import { ApiError } from "../../utils/errors";
import { nextDocumentNumber } from "../../utils/documentNumber";
import { postStockMovement } from "../../services/stockService";
import { postJournal, recordPostingException } from "../../services/journalService";
import { resolveCoaByCode } from "../../services/coaLookup";
import { triggerApproval } from "../../services/approvalService";
import { writeAuditLog } from "../../services/auditService";

const router = Router();

// --- Product classification: Group -> Subgroup -> Family, plus Brand ------
router.use(
  "/product-groups",
  crudRouter(prisma.productGroup, {
    permissionKey: "Inventory.ProductGroup",
    createSchema: z.object({ code: z.string().min(1).max(30), name: z.string().min(1) }),
  })
);
router.use(
  "/product-subgroups",
  crudRouter(prisma.productSubgroup, {
    permissionKey: "Inventory.ProductSubgroup",
    createSchema: z.object({ groupId: z.string().uuid(), code: z.string().min(1).max(30), name: z.string().min(1) }),
    include: { group: true },
  })
);
router.use(
  "/product-families",
  crudRouter(prisma.productFamily, {
    permissionKey: "Inventory.ProductFamily",
    createSchema: z.object({ subgroupId: z.string().uuid().optional(), code: z.string().min(1).max(30), name: z.string().min(1) }),
    include: { subgroup: true },
  })
);
router.use(
  "/brands",
  crudRouter(prisma.brand, {
    permissionKey: "Inventory.Brand",
    createSchema: z.object({ code: z.string().min(1).max(30), name: z.string().min(1) }),
  })
);

// --- Menus (POS/ordering groupings - an item can be on more than one) -----
router.use(
  "/menus",
  crudRouter(prisma.menu, {
    permissionKey: "Inventory.Menu",
    createSchema: z.object({ code: z.string().min(1).max(30), name: z.string().min(1) }),
  })
);
router.post(
  "/menus/:menuId/items",
  requirePermission("Inventory.Menu.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ itemId: z.string().uuid(), sortOrder: z.number().int().default(0) });
    const payload = schema.parse(req.body);
    const record = await prisma.menuItem.create({ data: { ...payload, tenantId, menuId: req.params.menuId } });
    res.status(201).json(record);
  })
);
router.get(
  "/menus/:menuId/items",
  requirePermission("Inventory.Menu.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const items = await prisma.menuItem.findMany({
      where: { tenantId, menuId: req.params.menuId },
      include: { item: true },
      orderBy: { sortOrder: "asc" },
    });
    res.json({ data: items });
  })
);

// --- Item Categories (legacy self-referencing tree, still supported
// alongside Group/Subgroup/Family for GL defaulting) -----------------------
router.use(
  "/item-categories",
  crudRouter(prisma.itemCategory, {
    permissionKey: "Inventory.ItemCategory",
    createSchema: z.object({
      parentId: z.string().uuid().optional(),
      code: z.string().min(1).max(30),
      name: z.string().min(1),
      defaultInventoryGlId: z.string().uuid().optional(),
      defaultCogsGlId: z.string().uuid().optional(),
    }),
    include: { parent: true },
  })
);

// --- Items (item / product master) -----------------------------------------------------------
router.use(
  "/items",
  crudRouter(prisma.item, {
    permissionKey: "Inventory.Item",
    createSchema: z.object({
      code: z.string().min(1).max(50),
      name: z.string().min(1),
      itemType: z.enum([
        "Sellable",
        "Stock",
        "Non-stock",
        "Stationary",
        "Menu",
        "Semi-finished",
        "Finished",
        "Packaging",
        "Service",
        "Spare",
      ]),
      forSales: z.boolean().default(false),
      forManufacture: z.boolean().default(false),
      forFactory: z.boolean().default(false),
      forPurchase: z.boolean().default(false),
      forPos: z.boolean().default(false),
      forExpense: z.boolean().default(false),
      shortName: z.string().max(30).optional(),
      barcode: z.string().optional(),
      categoryId: z.string().uuid().optional(),
      groupId: z.string().uuid().optional(),
      subgroupId: z.string().uuid().optional(),
      familyId: z.string().uuid().optional(),
      brandId: z.string().uuid().optional(),
      baseUomId: z.string().uuid(),
      purchaseUomId: z.string().uuid().optional(),
      salesUomId: z.string().uuid().optional(),
      defaultTaxId: z.string().uuid().optional(),
      costingMethod: z.enum(["Weighted Average", "Standard Cost", "FIFO"]).default("Weighted Average"),
      standardCost: z.number().nonnegative().optional(),
      batchRequired: z.boolean().default(false),
      expiryRequired: z.boolean().default(false),
      shelfLifeDays: z.number().int().nonnegative().optional(),
      reorderLevel: z.number().nonnegative().optional(),
      minStock: z.number().nonnegative().optional(),
      maxStock: z.number().nonnegative().optional(),
      preparationTimeMinutes: z.number().int().nonnegative().optional(),
      allergens: z.string().optional(),
      imageUrl: z.string().optional(),
      notes: z.string().optional(),
    }),
    include: {
      category: true, group: true, subgroup: true, family: true, brand: true,
      baseUom: true, purchaseUom: true, salesUom: true, defaultTax: true, glMapping: true,
    },
    sensitiveFields: {
      fields: ["standardCost", "lastReceivedCost", "averageCost"],
      requiredPermission: "Inventory.Item.ViewCost",
    },
    // Lets Raw Materials Master / Menu Master / Item Master each show a
    // pre-filtered slice of this same table via ?itemType=a,b,c - see
    // pages/products/ProductItemsView.tsx on the frontend.
    listFilters: ["itemType"],
  })
);

// --- Item costing / pricing summary ----------------------------------------
// Surfaces last received cost, cached weighted-average cost, every active
// selling price (an item can have several - by branch, channel/POS, and
// customer group, per ItemPrice), and gross-profit % computed per price
// against the average cost. GP% is always calculated, never stored, so it
// can never drift out of sync with cost or price changes.
router.get(
  "/items/:id/pricing-summary",
  requirePermission("Inventory.Item.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const item = await prisma.item.findFirst({ where: { id: req.params.id, tenantId } });
    if (!item) return res.status(404).json({ message: "Item not found" });

    const now = new Date();
    const prices = await prisma.itemPrice.findMany({
      where: {
        tenantId,
        itemId: item.id,
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
      },
      include: { branch: true, channel: true },
      orderBy: { effectiveFrom: "desc" },
    });

    const averageCost = item.averageCost !== null ? Number(item.averageCost) : null;
    const priceLines = prices.map((p) => {
      const price = Number(p.price);
      const gpPercent = averageCost !== null && price > 0 ? ((price - averageCost) / price) * 100 : null;
      return {
        id: p.id,
        branch: p.branch?.name ?? "All branches",
        channel: p.channel?.name ?? "All channels",
        customerGroupId: p.customerGroupId,
        price,
        gpPercent: gpPercent !== null ? Math.round(gpPercent * 100) / 100 : null,
        effectiveFrom: p.effectiveFrom,
        effectiveTo: p.effectiveTo,
      };
    });

    res.json({
      itemId: item.id,
      code: item.code,
      name: item.name,
      standardCost: item.standardCost,
      lastReceivedCost: item.lastReceivedCost,
      lastReceivedDate: item.lastReceivedDate,
      averageCost: item.averageCost,
      sellingPrices: priceLines,
    });
  })
);

// --- Item GL Mapping -----------------------------------------------------------
// One-to-one with Item (upsert keyed by itemId) - which accounts a
// product's stock, cost of goods, revenue, expense, and wastage should
// post to, overriding the company-wide control accounts that
// coaLookup.ts's resolveCoaByCode() falls back to today.
router.get(
  "/item-gl-mappings/:itemId",
  requirePermission("Inventory.ItemGlMapping.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.itemGlMapping.findFirst({ where: { itemId: req.params.itemId, tenantId } });
    res.json(record ?? { itemId: req.params.itemId });
  })
);

router.post(
  "/item-gl-mappings",
  requirePermission("Inventory.ItemGlMapping.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      itemId: z.string().uuid(),
      inventoryGlId: z.string().uuid().optional(),
      cogsGlId: z.string().uuid().optional(),
      revenueGlId: z.string().uuid().optional(),
      expenseGlId: z.string().uuid().optional(),
      wastageGlId: z.string().uuid().optional(),
    });
    const payload = schema.parse(req.body);
    const record = await prisma.itemGlMapping.upsert({
      where: { itemId: payload.itemId },
      update: payload,
      create: { ...payload, tenantId },
    });
    res.json(record);
  })
);

// --- Price Groups (named sets of branches that share one selling price) ---
// Create the group, assign branches to it below, then Item Prices picks a
// price group instead of a single branch - one price row covers every
// branch in the group.
router.use(
  "/price-groups",
  crudRouter(prisma.priceGroup, {
    permissionKey: "Inventory.PriceGroup",
    createSchema: z.object({ code: z.string().min(1).max(30), name: z.string().min(1) }),
  })
);

router.get(
  "/price-groups/:id/branches",
  requirePermission("Inventory.PriceGroup.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const rows = await prisma.priceGroupBranch.findMany({
      where: { tenantId, priceGroupId: req.params.id },
      include: { branch: true },
    });
    res.json({ data: rows });
  })
);

router.post(
  "/price-groups/:id/branches",
  requirePermission("Inventory.PriceGroup.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ branchId: z.string().uuid() });
    const { branchId } = schema.parse(req.body);
    const record = await prisma.priceGroupBranch.create({
      data: { tenantId, priceGroupId: req.params.id, branchId },
      include: { branch: true },
    });
    res.status(201).json(record);
  })
);

router.delete(
  "/price-groups/:id/branches/:branchLinkId",
  requirePermission("Inventory.PriceGroup.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.priceGroupBranch.findFirst({
      where: { id: req.params.branchLinkId, tenantId, priceGroupId: req.params.id },
    });
    if (!existing) throw ApiError.notFound();
    await prisma.priceGroupBranch.delete({ where: { id: existing.id } });
    res.status(204).send();
  })
);

// --- Item Pricing -----------------------------------------------------------
router.use(
  "/item-prices",
  crudRouter(prisma.itemPrice, {
    permissionKey: "Inventory.ItemPrice",
    createSchema: z.object({
      itemId: z.string().uuid(),
      priceGroupId: z.string().uuid().optional(),
      branchId: z.string().uuid().optional(),
      channelId: z.string().uuid().optional(),
      customerGroupId: z.string().uuid().optional(),
      price: z.number().nonnegative(),
      effectiveFrom: z.coerce.date().optional(),
      effectiveTo: z.coerce.date().optional(),
    }),
    include: { item: true, priceGroup: true, branch: true, channel: true },
    statusField: "customerGroupId",
    listFilters: ["itemId"],
  })
);

// --- Item <-> Vendor mapping -----------------------------------------------------------
router.use(
  "/item-vendor-mappings",
  crudRouter(prisma.itemVendorMapping, {
    permissionKey: "Inventory.ItemVendorMapping",
    createSchema: z.object({
      itemId: z.string().uuid(),
      vendorId: z.string().uuid(),
      vendorItemCode: z.string().optional(),
      leadTimeDays: z.number().int().nonnegative().optional(),
      lastPrice: z.number().nonnegative().optional(),
    }),
    include: { item: true, vendor: true },
    statusField: "vendorItemCode",
    listFilters: ["itemId"],
  })
);

// --- Item branch-level order quantities -------------------------------------
// Per-branch min/max order quantity - the item's own reorderLevel/minStock/
// maxStock are tenant-wide fallbacks; a branch with a row here overrides
// them for purchasing purposes at that branch specifically.
router.use(
  "/item-branch-settings",
  crudRouter(prisma.itemBranchSetting, {
    permissionKey: "Inventory.ItemBranchSetting",
    createSchema: z.object({
      itemId: z.string().uuid(),
      branchId: z.string().uuid(),
      minOrderQty: z.number().nonnegative().optional(),
      maxOrderQty: z.number().nonnegative().optional(),
    }),
    include: { item: true, branch: true },
    listFilters: ["itemId"],
  })
);

// --- Item purchase / sales history (read-only) -------------------------------
// Surfaced directly on the item edit screen so "which vendors have actually
// supplied this" and "how has it been selling" don't require navigating to
// the GRN/Sales Invoice modules separately - just the most recent lines,
// newest first, capped at 20 so the panel stays fast.
router.get(
  "/items/:itemId/purchase-history",
  requirePermission("Inventory.Item.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const lines = await prisma.grnLine.findMany({
      where: { tenantId, itemId: req.params.itemId, grn: { tenantId } },
      include: { grn: { include: { vendor: true, branch: true } } },
      orderBy: { grn: { grnDate: "desc" } },
      take: 20,
    });
    res.json({
      data: lines.map((l) => ({
        id: l.id,
        grnDate: l.grn.grnDate,
        grnNo: l.grn.grnNo,
        vendor: l.grn.vendor ? { id: l.grn.vendor.id, code: l.grn.vendor.code, name: l.grn.vendor.name } : null,
        branch: l.grn.branch?.name,
        receivedQty: l.receivedQty,
        acceptedQty: l.acceptedQty,
        unitCost: l.unitCost,
      })),
    });
  })
);

router.get(
  "/items/:itemId/sales-history",
  requirePermission("Inventory.Item.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const lines = await prisma.salesInvoiceLine.findMany({
      where: { tenantId, itemId: req.params.itemId, salesInvoice: { tenantId } },
      include: { salesInvoice: { include: { branch: true, customer: true } } },
      orderBy: { salesInvoice: { businessDate: "desc" } },
      take: 20,
    });
    res.json({
      data: lines.map((l) => ({
        id: l.id,
        businessDate: l.salesInvoice.businessDate,
        invoiceNo: l.salesInvoice.invoiceNo,
        branch: l.salesInvoice.branch?.name,
        customer: l.salesInvoice.customer?.name ?? "Walk-in / POS",
        qty: l.qty,
        unitPrice: l.unitPrice,
      })),
    });
  })
);

// --- Inter-Branch Transfer (IBT) --------------------------------------------
// Moves stock from one branch/warehouse's balance to another's - either
// created directly, or converted from a head-office MR consolidation marked
// "Internal" fulfillment (see POST /procurement/mr-consolidations/:id/convert-to-transfer).
// Posting is two real legs, not just a status label:
//   Transfer Out: fromWarehouse -qty, transitWarehouse +qty (goods are now
//   visibly "in transit" as an actual stock balance you can query).
//   Transfer In:  transitWarehouse -qty, toWarehouse +qty.
// The unit cost captured at Transfer Out rides along unchanged through both
// legs, so nothing gets revalued just because it moved branches.
const transferLineSchema = z.object({
  itemId: z.string().uuid(),
  qty: z.number().positive(),
  batchNo: z.string().optional(),
});

router.post(
  "/stock-transfers",
  requirePermission("Inventory.StockTransfer.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      fromBranchId: z.string().uuid(),
      toBranchId: z.string().uuid(),
      fromWarehouseId: z.string().uuid(),
      toWarehouseId: z.string().uuid(),
      transitWarehouseId: z.string().uuid(),
      notes: z.string().optional(),
      lines: z.array(transferLineSchema).min(1),
    });
    const payload = schema.parse(req.body);

    const transitWarehouse = await prisma.warehouse.findFirst({
      where: { id: payload.transitWarehouseId, tenantId },
    });
    if (!transitWarehouse) throw ApiError.badRequest("transitWarehouseId not found");
    if (!transitWarehouse.isInTransit) {
      throw ApiError.badRequest("transitWarehouseId must point to a warehouse flagged isInTransit = true");
    }

    const record = await prisma.$transaction(async (tx) => {
      const transferNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId: payload.companyId,
        moduleCode: "StockTransfer",
        defaultPrefix: "IBT",
      });
      return tx.stockTransfer.create({
        data: {
          tenantId,
          transferNo,
          fromBranchId: payload.fromBranchId,
          toBranchId: payload.toBranchId,
          fromWarehouseId: payload.fromWarehouseId,
          toWarehouseId: payload.toWarehouseId,
          transitWarehouseId: payload.transitWarehouseId,
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
  "/stock-transfers",
  requirePermission("Inventory.StockTransfer.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.fromBranchId) where.fromBranchId = req.query.fromBranchId;
    if (req.query.toBranchId) where.toBranchId = req.query.toBranchId;
    const items = await prisma.stockTransfer.findMany({
      where,
      include: { lines: true, fromBranch: true, toBranch: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: items });
  })
);

router.get(
  "/stock-transfers/:id",
  requirePermission("Inventory.StockTransfer.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.stockTransfer.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        lines: { include: { item: true } },
        fromBranch: true,
        toBranch: true,
        fromWarehouse: true,
        toWarehouse: true,
        transitWarehouse: true,
      },
    });
    if (!record) throw ApiError.notFound();
    res.json(record);
  })
);

router.post(
  "/stock-transfers/:id/submit",
  requirePermission("Inventory.StockTransfer.Submit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.stockTransfer.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    if (existing.status !== "Draft") throw ApiError.badRequest(`Cannot submit transfer in status ${existing.status}`);
    const record = await prisma.stockTransfer.update({ where: { id: existing.id }, data: { status: "Submitted" } });
    await triggerApproval(prisma, { tenantId, moduleCode: "Inventory.StockTransfer", recordId: record.id });
    await writeAuditLog(prisma, {
      tenantId,
      userId: req.user?.userId,
      moduleCode: "Inventory.StockTransfer",
      recordTable: "stock_transfers",
      recordId: record.id,
      action: "Submitted",
    });
    res.json(record);
  })
);

router.post(
  "/stock-transfers/:id/approve",
  requirePermission("Inventory.StockTransfer.Approve"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.stockTransfer.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    if (existing.status !== "Submitted") throw ApiError.badRequest(`Cannot approve transfer in status ${existing.status}`);
    const record = await prisma.stockTransfer.update({ where: { id: existing.id }, data: { status: "Approved" } });
    await writeAuditLog(prisma, {
      tenantId,
      userId: req.user?.userId,
      moduleCode: "Inventory.StockTransfer",
      recordTable: "stock_transfers",
      recordId: record.id,
      action: "Approved",
    });
    res.json(record);
  })
);

/**
 * Transfer Out: removes stock (and its value) from the source warehouse now,
 * at the item's current average cost, and lands it in the transit warehouse
 * in the same transaction - so "in transit" is a real, queryable stock
 * balance (GET /inventory/stock-balances?warehouseId=<transit>), not just a
 * status label. That captured cost is carried on each line for Transfer In.
 */
router.post(
  "/stock-transfers/:id/transfer-out",
  requirePermission("Inventory.StockTransfer.Dispatch"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const transfer = await prisma.stockTransfer.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: true },
    });
    if (!transfer) throw ApiError.notFound();
    if (transfer.status !== "Approved") throw ApiError.badRequest(`Cannot transfer out in status ${transfer.status}`);

    for (const line of transfer.lines) {
      const balance = await prisma.stockBalance.aggregate({
        where: { tenantId, itemId: line.itemId, warehouseId: transfer.fromWarehouseId },
        _sum: { quantity: true },
      });
      const available = Number(balance._sum.quantity ?? 0);
      if (Number(line.qty) > available + 1e-9) {
        throw ApiError.badRequest(`Not enough stock to transfer item ${line.itemId}: available ${available}, requested ${line.qty}`);
      }
    }

    await prisma.$transaction(async (tx) => {
      for (const line of transfer.lines) {
        const outResult = await postStockMovement(tx, {
          tenantId,
          itemId: line.itemId,
          warehouseId: transfer.fromWarehouseId,
          batchNo: line.batchNo,
          qtyOut: Number(line.qty),
          sourceModule: "InventoryOps",
          sourceDocType: "IBT-Out",
          sourceDocId: transfer.id,
        });
        await postStockMovement(tx, {
          tenantId,
          itemId: line.itemId,
          warehouseId: transfer.transitWarehouseId,
          batchNo: line.batchNo,
          qtyIn: Number(line.qty),
          unitCost: outResult.unitCostApplied,
          sourceModule: "InventoryOps",
          sourceDocType: "IBT-Out",
          sourceDocId: transfer.id,
        });
        await tx.stockTransferLine.update({ where: { id: line.id }, data: { unitCost: outResult.unitCostApplied } });
      }
      await tx.stockTransfer.update({ where: { id: transfer.id }, data: { status: "InTransit" } });
    });

    const updated = await prisma.stockTransfer.findUnique({ where: { id: transfer.id }, include: { lines: true } });
    res.json(updated);
  })
);

/**
 * Transfer In: moves the stock out of the transit warehouse and into the
 * destination warehouse once it actually arrives, at the same unit cost it
 * left the source at (no revaluation just for having moved).
 */
router.post(
  "/stock-transfers/:id/transfer-in",
  requirePermission("Inventory.StockTransfer.Receive"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const transfer = await prisma.stockTransfer.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: true },
    });
    if (!transfer) throw ApiError.notFound();
    if (transfer.status !== "InTransit") throw ApiError.badRequest(`Cannot transfer in in status ${transfer.status}`);

    await prisma.$transaction(async (tx) => {
      for (const line of transfer.lines) {
        await postStockMovement(tx, {
          tenantId,
          itemId: line.itemId,
          warehouseId: transfer.transitWarehouseId,
          batchNo: line.batchNo,
          qtyOut: Number(line.qty),
          sourceModule: "InventoryOps",
          sourceDocType: "IBT-In",
          sourceDocId: transfer.id,
        });
        await postStockMovement(tx, {
          tenantId,
          itemId: line.itemId,
          warehouseId: transfer.toWarehouseId,
          batchNo: line.batchNo,
          qtyIn: Number(line.qty),
          unitCost: Number(line.unitCost),
          sourceModule: "InventoryOps",
          sourceDocType: "IBT-In",
          sourceDocId: transfer.id,
        });
      }
      await tx.stockTransfer.update({ where: { id: transfer.id }, data: { status: "Received" } });
    });

    const updated = await prisma.stockTransfer.findUnique({ where: { id: transfer.id }, include: { lines: true } });
    res.json(updated);
  })
);

// --- Stock Adjustment --------------------------------------------------------
// Corrects stock on hand outside the normal purchase/consumption/transfer
// flows: physical count variance, damage, expiry write-off, theft/loss.
const adjustmentLineSchema = z.object({
  itemId: z.string().uuid(),
  batchNo: z.string().optional(),
  countedQty: z.number().nonnegative().optional(),
  adjustQty: z.number().optional(), // ignored if countedQty is given - computed as countedQty - systemQty instead
  unitCost: z.number().nonnegative().optional(),
});

router.post(
  "/stock-adjustments",
  requirePermission("Inventory.StockAdjustment.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      branchId: z.string().uuid(),
      warehouseId: z.string().uuid(),
      reason: z.enum(["Physical Count", "Damage", "Expiry", "Theft or Loss", "Other"]),
      notes: z.string().optional(),
      lines: z.array(adjustmentLineSchema).min(1),
    });
    const payload = schema.parse(req.body);

    const linesWithSnapshot: Array<z.infer<typeof adjustmentLineSchema> & { systemQty: number; adjustQty: number }> = [];
    for (const l of payload.lines) {
      const balance = await prisma.stockBalance.aggregate({
        where: { tenantId, itemId: l.itemId, warehouseId: payload.warehouseId, ...(l.batchNo ? { batchNo: l.batchNo } : {}) },
        _sum: { quantity: true },
      });
      const systemQty = Number(balance._sum.quantity ?? 0);
      const adjustQty = l.countedQty !== undefined ? l.countedQty - systemQty : l.adjustQty;
      if (adjustQty === undefined || adjustQty === 0) {
        throw ApiError.badRequest(`Line for item ${l.itemId} has no net change - provide countedQty or a non-zero adjustQty`);
      }
      linesWithSnapshot.push({ ...l, systemQty, adjustQty });
    }

    const record = await prisma.$transaction(async (tx) => {
      const adjustmentNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId: payload.companyId,
        moduleCode: "StockAdjustment",
        defaultPrefix: "ADJ",
      });
      return tx.stockAdjustment.create({
        data: {
          tenantId,
          adjustmentNo,
          branchId: payload.branchId,
          warehouseId: payload.warehouseId,
          reason: payload.reason,
          notes: payload.notes,
          lines: {
            create: linesWithSnapshot.map((l) => ({
              tenantId,
              itemId: l.itemId,
              batchNo: l.batchNo,
              systemQty: l.systemQty,
              countedQty: l.countedQty,
              adjustQty: l.adjustQty,
              unitCost: l.unitCost,
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
  "/stock-adjustments",
  requirePermission("Inventory.StockAdjustment.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.branchId) where.branchId = req.query.branchId;
    const items = await prisma.stockAdjustment.findMany({
      where,
      include: { lines: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: items });
  })
);

router.get(
  "/stock-adjustments/:id",
  requirePermission("Inventory.StockAdjustment.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.stockAdjustment.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: { include: { item: true } }, branch: true, warehouse: true },
    });
    if (!record) throw ApiError.notFound();
    res.json(record);
  })
);

router.post(
  "/stock-adjustments/:id/submit",
  requirePermission("Inventory.StockAdjustment.Submit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.stockAdjustment.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    if (existing.status !== "Draft") throw ApiError.badRequest(`Cannot submit adjustment in status ${existing.status}`);
    const record = await prisma.stockAdjustment.update({ where: { id: existing.id }, data: { status: "Submitted" } });
    await triggerApproval(prisma, { tenantId, moduleCode: "Inventory.StockAdjustment", recordId: record.id });
    await writeAuditLog(prisma, {
      tenantId,
      userId: req.user?.userId,
      moduleCode: "Inventory.StockAdjustment",
      recordTable: "stock_adjustments",
      recordId: record.id,
      action: "Submitted",
    });
    res.json(record);
  })
);

router.post(
  "/stock-adjustments/:id/approve",
  requirePermission("Inventory.StockAdjustment.Approve"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ approvedBy: z.string().uuid().optional() });
    const { approvedBy } = schema.parse(req.body);
    const existing = await prisma.stockAdjustment.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    if (existing.status !== "Submitted") throw ApiError.badRequest(`Cannot approve adjustment in status ${existing.status}`);
    const record = await prisma.stockAdjustment.update({
      where: { id: existing.id },
      data: { status: "Approved", approvedBy },
    });
    await writeAuditLog(prisma, {
      tenantId,
      userId: req.user?.userId,
      moduleCode: "Inventory.StockAdjustment",
      recordTable: "stock_adjustments",
      recordId: record.id,
      action: "Approved",
    });
    res.json(record);
  })
);

/**
 * Posts the adjustment: each line with a positive adjustQty posts a stock
 * increase (found stock) at unitCost (falling back to the item's average
 * cost); each negative line posts a decrease (written off) at whatever the
 * item's average cost is at that moment. Books the net variance value
 * against a dedicated Stock Adjustment account: Dr Inventory Asset / Cr
 * Stock Adjustment for a net increase, or the reverse for a net decrease.
 */
router.post(
  "/stock-adjustments/:id/post",
  requirePermission("Inventory.StockAdjustment.Post"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid() });
    const { companyId } = schema.parse(req.body);

    const adjustment = await prisma.stockAdjustment.findFirst({ where: { id: req.params.id, tenantId } });
    if (!adjustment) throw ApiError.notFound();
    if (adjustment.status !== "Approved") throw ApiError.badRequest(`Cannot post adjustment in status ${adjustment.status}`);

    const linesWithItem = await prisma.stockAdjustmentLine.findMany({
      where: { adjustmentId: adjustment.id },
      include: { item: true },
    });

    await prisma.$transaction(async (tx) => {
      let netValue = 0;
      for (const line of linesWithItem) {
        const qty = Number(line.adjustQty);
        if (qty === 0) continue;

        if (qty > 0) {
          const unitCost = line.unitCost && Number(line.unitCost) > 0 ? Number(line.unitCost) : Number(line.item.averageCost ?? 0);
          await postStockMovement(tx, {
            tenantId,
            itemId: line.itemId,
            warehouseId: adjustment.warehouseId,
            batchNo: line.batchNo,
            qtyIn: qty,
            unitCost,
            sourceModule: "InventoryOps",
            sourceDocType: "StockAdjustment",
            sourceDocId: adjustment.id,
          });
          netValue += qty * unitCost;
        } else {
          const result = await postStockMovement(tx, {
            tenantId,
            itemId: line.itemId,
            warehouseId: adjustment.warehouseId,
            batchNo: line.batchNo,
            qtyOut: Math.abs(qty),
            sourceModule: "InventoryOps",
            sourceDocType: "StockAdjustment",
            sourceDocId: adjustment.id,
          });
          netValue -= Math.abs(qty) * result.unitCostApplied;
        }
      }

      await tx.stockAdjustment.update({ where: { id: adjustment.id }, data: { status: "Posted" } });

      if (Math.abs(netValue) < 1e-9) return;

      const inventoryControl = await resolveCoaByCode(tx, tenantId, companyId, "INVENTORY-CONTROL");
      const stockAdjustmentGl = await resolveCoaByCode(tx, tenantId, companyId, "STOCK-ADJUSTMENT");

      if (inventoryControl && stockAdjustmentGl) {
        const amount = Math.abs(netValue);
        const lines =
          netValue > 0
            ? [{ accountId: inventoryControl.id, debit: amount }, { accountId: stockAdjustmentGl.id, credit: amount }]
            : [{ accountId: stockAdjustmentGl.id, debit: amount }, { accountId: inventoryControl.id, credit: amount }];
        await postJournal(tx, { tenantId, companyId, sourceModule: "InventoryOps", sourceDocId: adjustment.id, lines });
      } else {
        await recordPostingException(tx, {
          tenantId,
          sourceModule: "InventoryOps",
          sourceDocId: adjustment.id,
          exceptionType: "Missing GL",
          message: "INVENTORY-CONTROL or STOCK-ADJUSTMENT account not configured for this company",
        });
      }
    });

    const updated = await prisma.stockAdjustment.findUnique({ where: { id: adjustment.id }, include: { lines: true } });
    res.json(updated);
  })
);

// --- Stock Ledger (append-only, read-only API) ------------------------------
router.get(
  "/stock-ledger",
  requirePermission("Inventory.StockLedger.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.itemId) where.itemId = req.query.itemId;
    if (req.query.warehouseId) where.warehouseId = req.query.warehouseId;

    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize ?? 100)));

    const [items, total] = await Promise.all([
      prisma.stockLedger.findMany({
        where,
        orderBy: { movementDate: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.stockLedger.count({ where }),
    ]);
    res.json({ data: items, page, pageSize, total });
  })
);

// --- Stock Balances (materialized view, read-only API) ----------------------
router.get(
  "/stock-balances",
  requirePermission("Inventory.StockBalance.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.itemId) where.itemId = req.query.itemId;
    if (req.query.warehouseId) where.warehouseId = req.query.warehouseId;
    const items = await prisma.stockBalance.findMany({ where, include: { item: true, warehouse: true } });
    res.json({ data: items });
  })
);

// --- Inventory Reports -------------------------------------------------------
// BRD "Reports" module's inventory slice: stock valuation, reorder alerts,
// and slow-moving stock - all derived from stock_balances/stock_ledger
// rather than stored separately, same principle as stock_balances itself
// (always rebuildable, never a second source of truth).

/**
 * Current on-hand value per item (and rolled up per category), from the
 * materialized stock_balances - not a fresh ledger replay, so it's O(items
 * in scope) rather than O(all-time movements).
 */
router.get(
  "/reports/stock-valuation",
  requirePermission("Inventory.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      warehouseId: z.string().uuid().optional(),
      branchId: z.string().uuid().optional(),
      categoryId: z.string().uuid().optional(),
    });
    const { warehouseId, branchId, categoryId } = schema.parse(req.query);

    const balances = await prisma.stockBalance.findMany({
      where: {
        tenantId,
        ...(warehouseId ? { warehouseId } : {}),
        ...(branchId ? { warehouse: { branchId } } : {}),
        ...(categoryId ? { item: { categoryId } } : {}),
      },
      include: { item: { include: { category: true } } },
    });

    const byItem = new Map<string, { itemId: string; itemCode: string; itemName: string; categoryCode: string; categoryName: string; quantity: number; value: number }>();
    for (const b of balances) {
      const entry = byItem.get(b.itemId) ?? {
        itemId: b.itemId,
        itemCode: b.item.code,
        itemName: b.item.name,
        categoryCode: b.item.category?.code ?? "UNCATEGORIZED",
        categoryName: b.item.category?.name ?? "Uncategorized",
        quantity: 0,
        value: 0,
      };
      entry.quantity += Number(b.quantity);
      entry.value += Number(b.value);
      byItem.set(b.itemId, entry);
    }
    const items = [...byItem.values()].sort((a, b) => b.value - a.value);

    const byCategory = new Map<string, { categoryCode: string; categoryName: string; quantity: number; value: number }>();
    for (const it of items) {
      const entry = byCategory.get(it.categoryCode) ?? { categoryCode: it.categoryCode, categoryName: it.categoryName, quantity: 0, value: 0 };
      entry.quantity += it.quantity;
      entry.value += it.value;
      byCategory.set(it.categoryCode, entry);
    }

    res.json({
      data: items,
      byCategory: [...byCategory.values()].sort((a, b) => b.value - a.value),
      totalValue: items.reduce((s, it) => s + it.value, 0),
    });
  })
);

/**
 * Items whose current on-hand quantity has fallen at or below reorderLevel
 * (falling back to minStock if reorderLevel isn't set) - BRD inventory
 * ops "reorder level" alerting. Suggested reorder quantity tops back up to
 * maxStock when set, otherwise just to reorderLevel/minStock itself.
 */
router.get(
  "/reports/reorder-alert",
  requirePermission("Inventory.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ warehouseId: z.string().uuid().optional(), branchId: z.string().uuid().optional() });
    const { warehouseId, branchId } = schema.parse(req.query);

    const items = await prisma.item.findMany({
      where: {
        tenantId,
        status: "Active",
        OR: [{ reorderLevel: { not: null } }, { minStock: { not: null } }],
      },
    });
    if (items.length === 0) return res.json({ data: [] });

    const balances = await prisma.stockBalance.findMany({
      where: {
        tenantId,
        itemId: { in: items.map((i) => i.id) },
        ...(warehouseId ? { warehouseId } : {}),
        ...(branchId ? { warehouse: { branchId } } : {}),
      },
    });
    const qtyByItem = new Map<string, number>();
    for (const b of balances) qtyByItem.set(b.itemId, (qtyByItem.get(b.itemId) ?? 0) + Number(b.quantity));

    const alerts: any[] = [];
    for (const item of items) {
      const threshold = item.reorderLevel !== null ? Number(item.reorderLevel) : item.minStock !== null ? Number(item.minStock) : null;
      if (threshold === null) continue;
      const onHand = qtyByItem.get(item.id) ?? 0;
      if (onHand <= threshold) {
        const target = item.maxStock !== null ? Number(item.maxStock) : threshold;
        alerts.push({
          itemId: item.id,
          itemCode: item.code,
          itemName: item.name,
          onHand,
          reorderLevel: threshold,
          suggestedReorderQty: Math.max(0, target - onHand),
        });
      }
    }
    alerts.sort((a, b) => a.onHand - b.onHand);
    res.json({ data: alerts });
  })
);

/**
 * On-hand stock with no ledger movement (in or out) in the last `days`
 * (default 60) - slow-moving/dead-stock flag. Uses each item+warehouse's
 * most recent stock_ledger row; a balance with no ledger row at all (only
 * possible via a data-load edge case, since every balance is created by a
 * ledger-writing movement) is treated as maximally stale.
 */
router.get(
  "/reports/slow-moving",
  requirePermission("Inventory.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ days: z.coerce.number().int().positive().default(60), warehouseId: z.string().uuid().optional() });
    const { days, warehouseId } = schema.parse(req.query);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const balances = await prisma.stockBalance.findMany({
      where: { tenantId, quantity: { gt: 0 }, ...(warehouseId ? { warehouseId } : {}) },
      include: { item: true, warehouse: true },
    });
    if (balances.length === 0) return res.json({ data: [] });

    const lastMovements = await prisma.stockLedger.groupBy({
      by: ["itemId", "warehouseId"],
      where: { tenantId },
      _max: { movementDate: true },
    });
    const lastMoveMap = new Map<string, Date>();
    for (const m of lastMovements) {
      if (m._max.movementDate) lastMoveMap.set(`${m.itemId}:${m.warehouseId}`, m._max.movementDate);
    }

    const slow = balances
      .map((b) => {
        const lastMovementDate = lastMoveMap.get(`${b.itemId}:${b.warehouseId}`) ?? null;
        return {
          itemId: b.itemId,
          itemCode: b.item.code,
          itemName: b.item.name,
          warehouseCode: b.warehouse.code,
          warehouseName: b.warehouse.name,
          quantity: Number(b.quantity),
          value: Number(b.value),
          lastMovementDate,
          daysSinceMovement: lastMovementDate ? Math.floor((Date.now() - lastMovementDate.getTime()) / (1000 * 60 * 60 * 24)) : null,
        };
      })
      .filter((row) => !row.lastMovementDate || row.lastMovementDate < cutoff)
      .sort((a, b) => (b.daysSinceMovement ?? Infinity) - (a.daysSinceMovement ?? Infinity));

    res.json({ data: slow });
  })
);

export default router;
