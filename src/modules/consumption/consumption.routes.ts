import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePermission } from "../../middleware/rbac";
import { ApiError } from "../../utils/errors";
import { postStockMovement } from "../../services/stockService";
import { postJournal, recordPostingException } from "../../services/journalService";
import { resolveCoaByCode } from "../../services/coaLookup";
import { getEffectiveRecipeVersion, explodeRecipeVersion, explodeLineModifiers, mergeExplodedIngredients } from "../../services/recipeExplosion";

const router = Router();

/**
 * POST /consumption/generate
 * Implements BRD 5.8 "Recipe Consumption from Sales": explodes each posted
 * sales line's recipe version - the one actually effective on the sale's
 * business date, not just whichever version happens to be Approved right
 * now (BRD 5.6 "effective dates") - into ingredient consumption. Combo
 * ingredients are recursively exploded into their own ingredients, and any
 * modifiers attached to the line (BRD 5.6 "modifiers basic") are exploded
 * and merged in too, before wastage-adjusted stock-out and
 * Dr Food Cost/COGS / Cr Inventory Asset posting. Missing recipe/warehouse/GL
 * situations are routed to consumption_exceptions instead of failing the
 * whole run (ERD blueprint "Exception handling").
 *
 * UOM conversion between the recipe's ingredient UOM and the item's stock
 * UOM is assumed 1:1 in this MVP pass when no uom_conversions row exists -
 * a real deployment should treat a missing conversion as an exception too
 * (see BRD 5.8 exception types) once fractional-UOM POS items are common.
 */
router.post(
  "/generate",
  requirePermission("Consumption.ConsumptionPosting.Post"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      branchId: z.string().uuid(),
      businessDate: z.coerce.date(),
      warehouseId: z.string().uuid(),
    });
    const { companyId, branchId, businessDate, warehouseId } = schema.parse(req.body);

    const existing = await prisma.consumptionPosting.findFirst({ where: { tenantId, branchId, businessDate } });
    if (existing) throw ApiError.conflict("Consumption already generated for this branch/business date");

    const salesLines = await prisma.salesInvoiceLine.findMany({
      where: {
        tenantId,
        salesInvoice: { tenantId, branchId, businessDate, postingStatus: "Posted" },
      },
      include: { salesInvoice: true },
    });

    const posting = await prisma.consumptionPosting.create({
      data: { tenantId, branchId, businessDate, status: "Draft" },
    });

    let totalCost = 0;
    const exceptions: string[] = [];

    await prisma.$transaction(async (tx) => {
      for (const line of salesLines) {
        let recipeVersionId = line.recipeVersionId ?? undefined;

        if (!recipeVersionId && line.itemId) {
          const recipe = await tx.recipe.findFirst({ where: { tenantId, outputItemId: line.itemId } });
          if (recipe) {
            const effective = await getEffectiveRecipeVersion(tx, tenantId, recipe.id, businessDate);
            recipeVersionId = effective?.id;
          }
        }

        if (!recipeVersionId) {
          await tx.consumptionException.create({
            data: {
              tenantId,
              postingId: posting.id,
              salesLineId: line.id,
              exceptionType: "Missing Recipe",
              message: `No recipe effective as of ${businessDate.toISOString().slice(0, 10)} for sales line ${line.id}`,
            },
          });
          exceptions.push(`Missing Recipe: line ${line.id}`);
          continue;
        }

        const version = await tx.recipeVersion.findUniqueOrThrow({ where: { id: recipeVersionId }, include: { recipe: true } });
        const baseMultiplier = Number(line.qty) / Number(version.recipe.defaultOutputQty || 1);

        const baseExploded = await explodeRecipeVersion(tx, tenantId, recipeVersionId, baseMultiplier, businessDate);
        const modifierExploded = await explodeLineModifiers(tx, tenantId, line.id, Number(line.qty), businessDate);
        const ingredients = mergeExplodedIngredients([...baseExploded, ...modifierExploded]);

        for (const ing of ingredients) {
          const qty = ing.qty;
          if (qty === 0) continue;

          if (qty > 0) {
            const balance = await tx.stockBalance.aggregate({
              where: { tenantId, itemId: ing.ingredientItemId, warehouseId },
              _sum: { quantity: true },
            });
            const available = Number(balance._sum.quantity ?? 0);
            if (available < qty) {
              await tx.consumptionException.create({
                data: {
                  tenantId,
                  postingId: posting.id,
                  salesLineId: line.id,
                  exceptionType: "Negative Stock",
                  message: `Insufficient stock for item ${ing.ingredientItemId} in warehouse ${warehouseId} (need ${qty}, have ${available})`,
                },
              });
              exceptions.push(`Negative Stock: item ${ing.ingredientItemId}`);
              continue;
            }
          }

          // Modifier "removals" (negative qty, e.g. "no onions") reduce
          // planned consumption rather than posting an inbound movement -
          // they don't correspond to a real stock event on their own.
          if (qty < 0) continue;

          const movement = await postStockMovement(tx, {
            tenantId,
            itemId: ing.ingredientItemId,
            warehouseId,
            qtyOut: qty,
            sourceModule: "Consumption",
            sourceDocType: "ConsumptionPosting",
            sourceDocId: posting.id,
          });

          const lineCost = qty * movement.unitCostApplied;
          totalCost += lineCost;

          await tx.consumptionLine.create({
            data: {
              tenantId,
              postingId: posting.id,
              salesLineId: line.id,
              ingredientItemId: ing.ingredientItemId,
              warehouseId,
              qty,
              unitCost: movement.unitCostApplied,
              totalCost: lineCost,
            },
          });
        }
      }

      let journalId: string | undefined;
      if (totalCost > 0) {
        const cogsAccount = await resolveCoaByCode(tx, tenantId, companyId, "COGS-CONTROL");
        const inventoryControl = await resolveCoaByCode(tx, tenantId, companyId, "INVENTORY-CONTROL");
        if (cogsAccount && inventoryControl) {
          const journal = await postJournal(tx, {
            tenantId,
            companyId,
            sourceModule: "Consumption",
            sourceDocId: posting.id,
            lines: [
              { accountId: cogsAccount.id, debit: totalCost },
              { accountId: inventoryControl.id, credit: totalCost },
            ],
          });
          journalId = journal.id;
        } else {
          await recordPostingException(tx, {
            tenantId,
            sourceModule: "Consumption",
            sourceDocId: posting.id,
            exceptionType: "Missing GL",
            message: "COGS-CONTROL or INVENTORY-CONTROL account not configured for this company",
          });
        }
      }

      await tx.consumptionPosting.update({
        where: { id: posting.id },
        data: { status: exceptions.length > 0 ? "Exception" : "Posted", journalId },
      });
    });

    const result = await prisma.consumptionPosting.findUnique({
      where: { id: posting.id },
      include: { lines: true, exceptions: true },
    });
    res.status(201).json({ posting: result, totalCost });
  })
);

router.get(
  "/postings",
  requirePermission("Consumption.ConsumptionPosting.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const items = await prisma.consumptionPosting.findMany({
      where: { tenantId },
      include: { lines: true, exceptions: true },
      orderBy: { businessDate: "desc" },
    });
    res.json({ data: items });
  })
);

router.get(
  "/exceptions",
  requirePermission("Consumption.ConsumptionException.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.consumptionException.findMany({ where, orderBy: { createdAt: "desc" } });
    res.json({ data: items });
  })
);

// --- Consumption Variance Report ----------------------------------------------
/**
 * Theoretical vs actual consumption, per ingredient item, over a date
 * range. A note on what "actual" means here: this system has no
 * independent real-time actual-usage sensor (no scale/RFID feed) - the
 * only place a genuine physical count of an ingredient gets recorded is a
 * Stock Adjustment with reason Physical Count/Damage/Expiry/Theft or Loss.
 * A negative adjustQty there, on top of what recipe-driven theoretical
 * consumption already posted, IS the actual-vs-theoretical gap (wastage,
 * over-portioning, spoilage, or theft) - that's the honest, data-grounded
 * proxy used below rather than inventing a separate "actual" figure that
 * has no real source in this data model.
 *
 * Shrinkage value uses the item's *current* cached average cost as an
 * approximation, not the historical cost at the time of each adjustment -
 * a simplification worth knowing about if costs moved a lot during the
 * period.
 */
router.get(
  "/reports/variance",
  requirePermission("Consumption.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      fromDate: z.coerce.date(),
      toDate: z.coerce.date(),
      branchId: z.string().uuid().optional(),
      itemId: z.string().uuid().optional(),
    });
    const { fromDate, toDate, branchId, itemId } = schema.parse(req.query);

    const [consumptionLines, adjustmentLines] = await Promise.all([
      prisma.consumptionLine.findMany({
        where: {
          tenantId,
          ...(itemId ? { ingredientItemId: itemId } : {}),
          posting: {
            tenantId,
            status: "Posted",
            businessDate: { gte: fromDate, lte: toDate },
            ...(branchId ? { branchId } : {}),
          },
        },
        include: { ingredientItem: true },
      }),
      prisma.stockAdjustmentLine.findMany({
        where: {
          tenantId,
          adjustQty: { lt: 0 },
          ...(itemId ? { itemId } : {}),
          adjustment: {
            tenantId,
            status: "Posted",
            reason: { in: ["Physical Count", "Damage", "Expiry", "Theft or Loss"] },
            adjustmentDate: { gte: fromDate, lte: toDate },
            ...(branchId ? { branchId } : {}),
          },
        },
        include: { item: true },
      }),
    ]);

    const byItem = new Map<
      string,
      { itemId: string; itemCode: string; itemName: string; theoreticalQty: number; theoreticalCost: number; shrinkageQty: number; shrinkageValue: number }
    >();
    for (const line of consumptionLines) {
      const entry = byItem.get(line.ingredientItemId) ?? {
        itemId: line.ingredientItemId,
        itemCode: line.ingredientItem.code,
        itemName: line.ingredientItem.name,
        theoreticalQty: 0,
        theoreticalCost: 0,
        shrinkageQty: 0,
        shrinkageValue: 0,
      };
      entry.theoreticalQty += Number(line.qty);
      entry.theoreticalCost += Number(line.totalCost);
      byItem.set(line.ingredientItemId, entry);
    }
    for (const line of adjustmentLines) {
      const entry = byItem.get(line.itemId) ?? {
        itemId: line.itemId,
        itemCode: line.item.code,
        itemName: line.item.name,
        theoreticalQty: 0,
        theoreticalCost: 0,
        shrinkageQty: 0,
        shrinkageValue: 0,
      };
      const shrinkQty = Math.abs(Number(line.adjustQty));
      entry.shrinkageQty += shrinkQty;
      entry.shrinkageValue += shrinkQty * Number(line.item.averageCost ?? 0);
      byItem.set(line.itemId, entry);
    }

    const data = [...byItem.values()]
      .map((row) => ({
        ...row,
        variancePct: row.theoreticalQty > 0 ? (row.shrinkageQty / row.theoreticalQty) * 100 : null,
      }))
      .sort((a, b) => b.shrinkageValue - a.shrinkageValue);

    res.json({
      data,
      totals: {
        theoreticalCost: data.reduce((s, r) => s + r.theoreticalCost, 0),
        shrinkageValue: data.reduce((s, r) => s + r.shrinkageValue, 0),
      },
    });
  })
);

export default router;
