import { Prisma, PrismaClient } from "@prisma/client";
import { assertPeriodOpen } from "./periodService";
import { writeAuditLog } from "./auditService";
import { getCompanyPolicy } from "./policyService";
import { ApiError } from "../utils/errors";

type Tx = PrismaClient | Prisma.TransactionClient;

export interface StockMovementInput {
  tenantId: string;
  itemId: string;
  warehouseId: string;
  batchNo?: string | null;
  expiryDate?: Date | null;
  movementDate?: Date;
  qtyIn?: number;
  qtyOut?: number;
  /** Required when qtyIn > 0. Ignored (computed) for qtyOut-only movements. */
  unitCost?: number;
  sourceModule: string;
  sourceDocType?: string;
  sourceDocId: string;
}

/**
 * Appends one row to the append-only stock_ledger and updates the
 * materialized stock_balances row, per ERD blueprint section 12
 * ("Posting and Ledger Strategy"): weighted-average costing (MVP default
 * per BRD 5.5), stock_balance maintained by the posting service and always
 * rebuildable from the ledger.
 *
 * Returns the unit cost actually applied to the movement (the item's
 * weighted-average cost immediately before this movement, for qtyOut rows -
 * needed by callers like consumption posting to book COGS at the right cost).
 */
export async function postStockMovement(tx: Tx, input: StockMovementInput) {
  const {
    tenantId,
    itemId,
    warehouseId,
    batchNo = "",
    expiryDate = null,
    movementDate = new Date(),
    qtyIn = 0,
    qtyOut = 0,
    sourceModule,
    sourceDocType,
    sourceDocId,
  } = input;

  if (qtyIn > 0 && qtyOut > 0) {
    throw new Error("A single stock movement row cannot mix qtyIn and qtyOut");
  }
  if (qtyIn > 0 && (input.unitCost === undefined || input.unitCost === null)) {
    throw new Error("unitCost is required for a positive (inbound) stock movement");
  }

  const warehouse = await tx.warehouse.findUniqueOrThrow({
    where: { id: warehouseId },
    include: { branch: true },
  });
  await assertPeriodOpen(tx, {
    tenantId,
    companyId: warehouse.branch.companyId,
    date: movementDate,
    kind: "Inventory",
  });

  const balanceKey = {
    tenantId_itemId_warehouseId_batchNo_expiryDate: {
      tenantId,
      itemId,
      warehouseId,
      batchNo: batchNo ?? "",
      expiryDate: expiryDate as any,
    },
  };

  const existingBalance = await tx.stockBalance.findUnique({ where: balanceKey as any });
  const priorQty = existingBalance ? Number(existingBalance.quantity) : 0;
  const priorValue = existingBalance ? Number(existingBalance.value) : 0;
  const priorAvgCost = priorQty !== 0 ? priorValue / priorQty : 0;

  // Was never enforced anywhere before - defaults to true (today's actual
  // behaviour: nothing blocks it) so turning this on is an explicit,
  // opt-in choice from the Company Policies screen rather than a silent
  // behaviour change for tenants who haven't touched that setting.
  if (qtyOut > 0) {
    const allowNegativeStock = await getCompanyPolicy(tx, {
      tenantId,
      companyId: warehouse.branch.companyId,
      policyKey: "allowNegativeStock",
      defaultValue: true,
    });
    if (!allowNegativeStock && priorQty - qtyOut < 0) {
      throw ApiError.badRequest(
        `This would take stock negative (have ${priorQty}, moving out ${qtyOut}) and this company's policy disallows negative stock.`,
        { priorQty, qtyOut }
      );
    }
  }

  const appliedUnitCost = qtyIn > 0 ? Number(input.unitCost) : priorAvgCost;

  const ledgerEntry = await tx.stockLedger.create({
    data: {
      tenantId,
      itemId,
      warehouseId,
      batchNo: batchNo || null,
      expiryDate,
      movementDate,
      qtyIn,
      qtyOut,
      unitCost: appliedUnitCost,
      sourceModule,
      sourceDocType,
      sourceDocId,
    },
  });

  const newQty = priorQty + qtyIn - qtyOut;
  const newValue = priorValue + qtyIn * appliedUnitCost - qtyOut * priorAvgCost;

  await tx.stockBalance.upsert({
    where: balanceKey as any,
    update: { quantity: newQty, value: newValue },
    create: {
      tenantId,
      itemId,
      warehouseId,
      batchNo: batchNo ?? "",
      expiryDate,
      quantity: newQty,
      value: newValue,
    },
  });

  await refreshItemCostFields(tx, tenantId, itemId, qtyIn > 0 ? appliedUnitCost : undefined, movementDate);

  // No userId here - postStockMovement() isn't threaded with the acting
  // user across its ~15 call sites. The audit row still captures what
  // moved, when, and which document caused it via sourceModule/sourceDocId;
  // "who" is recoverable from that source document's own audit trail.
  await writeAuditLog(tx, {
    tenantId,
    moduleCode: sourceModule,
    recordTable: "stock_ledger",
    recordId: ledgerEntry.id,
    action: "Posted",
    newValue: { itemId, warehouseId, batchNo, qtyIn, qtyOut, unitCost: appliedUnitCost, sourceDocType, sourceDocId },
  });

  return { ledgerEntry, unitCostApplied: appliedUnitCost, newQty, newValue };
}

/**
 * Recomputes an item's cached average cost (weighted-average value/quantity
 * across all warehouses, from stock_balances) and, on a receipt (qtyIn > 0),
 * its last-received cost/date. Cached on the item for fast product-master
 * lookups (avg cost, GP%, valuation) without re-aggregating stock_ledger on
 * every read; the cache is always rebuildable from stock_balances/ledger.
 */
async function refreshItemCostFields(
  tx: Tx,
  tenantId: string,
  itemId: string,
  receivedUnitCost: number | undefined,
  movementDate: Date
) {
  const agg = await tx.stockBalance.aggregate({
    where: { tenantId, itemId },
    _sum: { quantity: true, value: true },
  });
  const totalQty = Number(agg._sum.quantity ?? 0);
  const totalValue = Number(agg._sum.value ?? 0);
  const averageCost = totalQty !== 0 ? totalValue / totalQty : null;

  await tx.item.update({
    where: { id: itemId },
    data: {
      averageCost,
      ...(receivedUnitCost !== undefined
        ? { lastReceivedCost: receivedUnitCost, lastReceivedDate: movementDate }
        : {}),
    },
  });
}
