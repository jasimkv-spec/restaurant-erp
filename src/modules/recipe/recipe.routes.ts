import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePermission } from "../../middleware/rbac";
import { ApiError } from "../../utils/errors";
import { nextDocumentNumber } from "../../utils/documentNumber";
import { postStockMovement } from "../../services/stockService";
import { postJournal, recordPostingException } from "../../services/journalService";
import { resolveCoaByCode } from "../../services/coaLookup";
import { explodeRecipeVersion } from "../../services/recipeExplosion";

const router = Router();

const ingredientSchema = z.object({
  ingredientItemId: z.string().uuid(),
  // Positive = normal ingredient. Negative is only valid on a Modifier-type
  // recipe (e.g. "no onions" = a negative onion qty) - it reduces
  // consumption rather than posting an inbound movement. Zero is never valid.
  qty: z.number().refine((v) => v !== 0, "qty cannot be zero"),
  uomId: z.string().uuid(),
  wastagePct: z.number().min(0).max(100).default(0),
  isPackaging: z.boolean().default(false),
});

// --- Recipes ----------------------------------------------------------
router.get(
  "/recipes",
  requirePermission("Recipe.Recipe.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    // Lets the item edit screen ask "does this product already have a
    // recipe/BOM/kit?" without fetching every recipe in the tenant.
    if (typeof req.query.outputItemId === "string" && req.query.outputItemId.length > 0) {
      where.outputItemId = req.query.outputItemId;
    }
    const items = await prisma.recipe.findMany({
      where,
      include: {
        outputItem: true,
        versions: {
          orderBy: { versionNo: "desc" },
          take: 1,
          include: { ingredients: { include: { ingredientItem: true, uom: true } } },
        },
      },
      orderBy: { id: "desc" },
    });
    res.json({ data: items });
  })
);

router.post(
  "/recipes",
  requirePermission("Recipe.Recipe.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      outputItemId: z.string().uuid(),
      recipeType: z.enum([
        "Menu",
        "Semi-finished",
        "Production BOM",
        "Modifier",
        "Packaging",
        "Combo",
        "Staff Meal",
        "Catering",
      ]),
      defaultOutputQty: z.number().positive().default(1),
      // First version can be created inline for convenience.
      ingredients: z.array(ingredientSchema).optional(),
    });
    const payload = schema.parse(req.body);

    const record = await prisma.$transaction(async (tx) => {
      const recipe = await tx.recipe.create({
        data: {
          tenantId,
          outputItemId: payload.outputItemId,
          recipeType: payload.recipeType,
          defaultOutputQty: payload.defaultOutputQty,
        },
      });
      if (payload.ingredients?.length) {
        await tx.recipeVersion.create({
          data: {
            tenantId,
            recipeId: recipe.id,
            versionNo: 1,
            ingredients: { create: payload.ingredients.map((i) => ({ ...i, tenantId })) },
          },
        });
      }
      return tx.recipe.findUnique({ where: { id: recipe.id }, include: { versions: { include: { ingredients: true } } } });
    });

    res.status(201).json(record);
  })
);

router.get(
  "/recipes/:id",
  requirePermission("Recipe.Recipe.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.recipe.findFirst({
      where: { id: req.params.id, tenantId },
      include: { outputItem: true, versions: { include: { ingredients: { include: { ingredientItem: true, uom: true } } } } },
    });
    if (!record) throw ApiError.notFound();
    res.json(record);
  })
);

// --- Recipe Versions ----------------------------------------------------------
router.post(
  "/recipes/:id/versions",
  requirePermission("Recipe.RecipeVersion.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const recipe = await prisma.recipe.findFirst({ where: { id: req.params.id, tenantId } });
    if (!recipe) throw ApiError.notFound();

    const schema = z.object({
      effectiveFrom: z.coerce.date().optional(),
      ingredients: z.array(ingredientSchema).min(1),
    });
    const payload = schema.parse(req.body);

    const lastVersion = await prisma.recipeVersion.findFirst({
      where: { tenantId, recipeId: recipe.id },
      orderBy: { versionNo: "desc" },
    });

    const version = await prisma.recipeVersion.create({
      data: {
        tenantId,
        recipeId: recipe.id,
        versionNo: (lastVersion?.versionNo ?? 0) + 1,
        effectiveFrom: payload.effectiveFrom,
        ingredients: { create: payload.ingredients.map((i) => ({ ...i, tenantId })) },
      },
      include: { ingredients: true },
    });

    res.status(201).json(version);
  })
);

/** Sums a recipe version's ingredient cost. Prefers the given warehouse's
 * own weighted-average balance (so cost genuinely reflects that branch's
 * ingredient prices); falls back to the item's tenant-wide average cost if
 * no warehouse is given or that warehouse has no balance yet. */
async function computeRecipeVersionCost(
  tx: typeof prisma,
  tenantId: string,
  ingredients: { ingredientItemId: string; qty: unknown; wastagePct: unknown }[],
  warehouseId?: string
) {
  let totalCost = 0;
  for (const ing of ingredients) {
    const wastageFactor = 1 + Number(ing.wastagePct) / 100;
    let unitCost = 0;
    if (warehouseId) {
      const balance = await tx.stockBalance.aggregate({
        where: { tenantId, itemId: ing.ingredientItemId, warehouseId },
        _sum: { quantity: true, value: true },
      });
      const qty = Number(balance._sum.quantity ?? 0);
      if (qty !== 0) unitCost = Number(balance._sum.value ?? 0) / qty;
    }
    if (unitCost === 0) {
      const item = await tx.item.findUnique({ where: { id: ing.ingredientItemId } });
      unitCost = item?.averageCost ? Number(item.averageCost) : 0;
    }
    totalCost += Number(ing.qty) * wastageFactor * unitCost;
  }
  return totalCost;
}

/** Approves a recipe version and computes/stores its cost snapshot from the
 * ingredients' current weighted-average stock cost, per BRD 5.6:
 * "Approved recipe versioning with effective dates, costing snapshot ...". */
router.post(
  "/recipe-versions/:id/approve",
  requirePermission("Recipe.RecipeVersion.Approve"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ approvedBy: z.string().uuid().optional(), warehouseId: z.string().uuid().optional() });
    const { approvedBy, warehouseId } = schema.parse(req.body);

    const version = await prisma.recipeVersion.findFirst({
      where: { id: req.params.id, tenantId },
      include: { ingredients: true },
    });
    if (!version) throw ApiError.notFound();

    const totalCost = await computeRecipeVersionCost(prisma, tenantId, version.ingredients, warehouseId);
    const warehouse = warehouseId ? await prisma.warehouse.findUnique({ where: { id: warehouseId } }) : null;

    await prisma.$transaction(async (tx) => {
      // Supersede any previously-approved version of the same recipe.
      await tx.recipeVersion.updateMany({
        where: { tenantId, recipeId: version.recipeId, status: "Approved" },
        data: { status: "Superseded" },
      });
      await tx.recipeVersion.update({
        where: { id: version.id },
        data: { status: "Approved", approvedBy },
      });
      await tx.recipeCostSnapshot.create({
        data: { tenantId, recipeVersionId: version.id, totalCost, warehouseId, branchId: warehouse?.branchId },
      });
    });

    const updated = await prisma.recipeVersion.findUnique({
      where: { id: version.id },
      include: { costSnapshots: { orderBy: { costDate: "desc" }, take: 1 } },
    });
    res.json(updated);
  })
);

/**
 * Refreshes a version's cost for one specific branch/warehouse, per BRD 5.6
 * "branch applicability" - usable any time after approval, independent of
 * re-approving the whole version, so a branch's ingredient price changes
 * can be reflected without touching the approved recipe itself.
 */
router.post(
  "/recipe-versions/:id/recompute-cost",
  requirePermission("Recipe.RecipeVersion.Approve"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ warehouseId: z.string().uuid() });
    const { warehouseId } = schema.parse(req.body);

    const version = await prisma.recipeVersion.findFirst({
      where: { id: req.params.id, tenantId },
      include: { ingredients: true },
    });
    if (!version) throw ApiError.notFound();
    const warehouse = await prisma.warehouse.findFirst({ where: { id: warehouseId, tenantId } });
    if (!warehouse) throw ApiError.badRequest("warehouseId not found");

    const totalCost = await computeRecipeVersionCost(prisma, tenantId, version.ingredients, warehouseId);
    const snapshot = await prisma.recipeCostSnapshot.create({
      data: { tenantId, recipeVersionId: version.id, totalCost, warehouseId, branchId: warehouse.branchId },
    });

    res.status(201).json(snapshot);
  })
);

router.get(
  "/recipe-versions/:id/cost-snapshots",
  requirePermission("Recipe.Recipe.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId, recipeVersionId: req.params.id };
    if (req.query.warehouseId) where.warehouseId = req.query.warehouseId;
    if (req.query.branchId) where.branchId = req.query.branchId;
    const items = await prisma.recipeCostSnapshot.findMany({ where, orderBy: { costDate: "desc" } });
    res.json({ data: items });
  })
);

// --- Production Posting -------------------------------------------------------
// Executes a Semi-finished / Production BOM recipe: consumes its ingredients
// and produces the output item's stock, at the cost the ingredients
// actually cost. This is what makes those recipe types operational.
router.post(
  "/production-postings",
  requirePermission("Recipe.ProductionPosting.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      recipeVersionId: z.string().uuid(),
      warehouseId: z.string().uuid(),
      branchId: z.string().uuid().optional(),
      outputQty: z.number().positive(),
      postingDate: z.coerce.date().optional(),
    });
    const payload = schema.parse(req.body);

    const version = await prisma.recipeVersion.findFirst({
      where: { id: payload.recipeVersionId, tenantId },
      include: { recipe: true },
    });
    if (!version) throw ApiError.badRequest("recipeVersionId not found");
    if (version.status !== "Approved") throw ApiError.badRequest("Recipe version must be Approved to produce from it");

    const postingDate = payload.postingDate ?? new Date();
    const multiplier = payload.outputQty / Number(version.recipe.defaultOutputQty || 1);
    const exploded = await explodeRecipeVersion(prisma, tenantId, version.id, multiplier, postingDate);

    const record = await prisma.$transaction(async (tx) => {
      const postingNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId: payload.companyId,
        moduleCode: "ProductionPosting",
        defaultPrefix: "PRD",
      });
      return tx.productionPosting.create({
        data: {
          tenantId,
          postingNo,
          recipeVersionId: version.id,
          warehouseId: payload.warehouseId,
          branchId: payload.branchId,
          outputQty: payload.outputQty,
          postingDate,
          lines: {
            create: exploded.filter((l) => l.qty > 0).map((l) => ({ tenantId, ingredientItemId: l.ingredientItemId, qty: l.qty })),
          },
        },
        include: { lines: true },
      });
    });

    res.status(201).json(record);
  })
);

router.get(
  "/production-postings",
  requirePermission("Recipe.ProductionPosting.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.warehouseId) where.warehouseId = req.query.warehouseId;
    const items = await prisma.productionPosting.findMany({ where, include: { lines: true }, orderBy: { createdAt: "desc" } });
    res.json({ data: items });
  })
);

router.get(
  "/production-postings/:id",
  requirePermission("Recipe.ProductionPosting.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.productionPosting.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: { include: { ingredientItem: true } }, recipeVersion: { include: { recipe: true } } },
    });
    if (!record) throw ApiError.notFound();
    res.json(record);
  })
);

/**
 * Posts the production: consumes each ingredient line (qtyOut at its
 * current average cost) and produces the recipe's output item into the same
 * warehouse (qtyIn at the total ingredient cost / outputQty), then books
 * Dr <output item's inventory GL> / Cr <ingredients' inventory GL(s)> -
 * an internal stock-to-stock value transfer, not a P&L event.
 */
router.post(
  "/production-postings/:id/post",
  requirePermission("Recipe.ProductionPosting.Post"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid() });
    const { companyId } = schema.parse(req.body);

    const posting = await prisma.productionPosting.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: true, recipeVersion: { include: { recipe: { include: { outputItem: { include: { category: true } } } } } } },
    });
    if (!posting) throw ApiError.notFound();
    if (posting.status !== "Draft") throw ApiError.badRequest(`Production posting already ${posting.status}`);

    await prisma.$transaction(async (tx) => {
      const glTotals = new Map<string, number>(); // accountId -> value consumed (credit side)
      let totalCost = 0;

      for (const line of posting.lines) {
        const result = await postStockMovement(tx, {
          tenantId,
          itemId: line.ingredientItemId,
          warehouseId: posting.warehouseId,
          qtyOut: Number(line.qty),
          sourceModule: "Recipe",
          sourceDocType: "ProductionPosting",
          sourceDocId: posting.id,
        });
        const lineCost = Number(line.qty) * result.unitCostApplied;
        totalCost += lineCost;
        await tx.productionPostingLine.update({
          where: { id: line.id },
          data: { unitCost: result.unitCostApplied, totalCost: lineCost },
        });

        const ingredientItem = await tx.item.findUnique({ where: { id: line.ingredientItemId }, include: { category: true } });
        const ingredientGl =
          (ingredientItem?.category?.defaultInventoryGlId &&
            (await tx.chartOfAccount.findUnique({ where: { id: ingredientItem.category.defaultInventoryGlId } }))) ||
          (await resolveCoaByCode(tx, tenantId, companyId, "INVENTORY-CONTROL"));
        if (ingredientGl) {
          glTotals.set(ingredientGl.id, (glTotals.get(ingredientGl.id) ?? 0) + lineCost);
        }
      }

      const outputUnitCost = Number(posting.outputQty) > 0 ? totalCost / Number(posting.outputQty) : 0;
      await postStockMovement(tx, {
        tenantId,
        itemId: posting.recipeVersion.recipe.outputItemId,
        warehouseId: posting.warehouseId,
        qtyIn: Number(posting.outputQty),
        unitCost: outputUnitCost,
        sourceModule: "Recipe",
        sourceDocType: "ProductionPosting",
        sourceDocId: posting.id,
      });

      await tx.productionPosting.update({ where: { id: posting.id }, data: { status: "Posted", totalCost } });

      if (totalCost > 0 && glTotals.size > 0) {
        const outputGl =
          (posting.recipeVersion.recipe.outputItem.category?.defaultInventoryGlId &&
            (await tx.chartOfAccount.findUnique({ where: { id: posting.recipeVersion.recipe.outputItem.category.defaultInventoryGlId } }))) ||
          (await resolveCoaByCode(tx, tenantId, companyId, "INVENTORY-CONTROL"));
        if (outputGl) {
          const lines = [
            { accountId: outputGl.id, debit: totalCost },
            ...Array.from(glTotals.entries()).map(([accountId, value]) => ({ accountId, credit: value })),
          ];
          await postJournal(tx, { tenantId, companyId, sourceModule: "Recipe", sourceDocId: posting.id, lines });
        } else {
          await recordPostingException(tx, {
            tenantId,
            sourceModule: "Recipe",
            sourceDocId: posting.id,
            exceptionType: "Missing GL",
            message: "No inventory GL account resolvable for the produced item",
          });
        }
      }
    });

    const updated = await prisma.productionPosting.findUnique({ where: { id: posting.id }, include: { lines: true } });
    res.json(updated);
  })
);

export default router;
