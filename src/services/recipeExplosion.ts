import { Prisma, PrismaClient } from "@prisma/client";

type Tx = PrismaClient | Prisma.TransactionClient;

export interface ExplodedIngredient {
  ingredientItemId: string;
  qty: number; // already includes wastage and multiplier - negative for modifier removals
  isPackaging: boolean;
}

/**
 * Finds the recipe version that was actually effective on a given date -
 * not just "whatever is Approved right now". Approving a new version
 * supersedes the old one immediately, but a sale being posted late (e.g.
 * yesterday's business date, imported today) should still cost against the
 * version that was in force on that business date, per BRD 5.6 "approved
 * recipe versioning with effective dates". Considers both Approved and
 * Superseded versions and picks the latest one whose effectiveFrom is on or
 * before asOfDate.
 */
export async function getEffectiveRecipeVersion(tx: Tx, tenantId: string, recipeId: string, asOfDate: Date) {
  return tx.recipeVersion.findFirst({
    where: {
      tenantId,
      recipeId,
      status: { in: ["Approved", "Superseded"] },
      effectiveFrom: { lte: asOfDate },
    },
    orderBy: { effectiveFrom: "desc" },
  });
}

/**
 * Recursively explodes a recipe version's ingredients into leaf stock
 * items. Per BRD 5.6 "combo explosion": when an ingredient is itself the
 * output of a Combo-type recipe (e.g. a "Combo Meal" line inside a bigger
 * bundle), that ingredient is not consumed directly from stock - it is
 * exploded into its own ingredients instead, recursively. Semi-finished /
 * Production BOM items are NOT auto-exploded here: those must be built up
 * ahead of time via ProductionPosting and are consumed directly from their
 * own stock balance, matching real kitchen practice (you can't explode a
 * cooked sauce back into raw ingredients at the point of sale).
 *
 * multiplier scales every ingredient qty (e.g. sold qty / recipe's
 * defaultOutputQty). depth guards against a mis-authored circular recipe.
 */
export async function explodeRecipeVersion(
  tx: Tx,
  tenantId: string,
  recipeVersionId: string,
  multiplier: number,
  asOfDate: Date,
  depth = 0
): Promise<ExplodedIngredient[]> {
  if (depth > 5) {
    throw new Error("Recipe explosion exceeded max depth (5) - check for a circular combo reference");
  }

  const version = await tx.recipeVersion.findUniqueOrThrow({
    where: { id: recipeVersionId },
    include: { ingredients: true, recipe: true },
  });

  const results: ExplodedIngredient[] = [];

  for (const ing of version.ingredients) {
    const effectiveQty = Number(ing.qty) * multiplier * (1 + Number(ing.wastagePct) / 100);

    const subRecipe = await tx.recipe.findFirst({
      where: { tenantId, outputItemId: ing.ingredientItemId, recipeType: "Combo" },
    });

    if (subRecipe) {
      const subVersion = await getEffectiveRecipeVersion(tx, tenantId, subRecipe.id, asOfDate);
      if (subVersion) {
        const subMultiplier = effectiveQty / Number(subRecipe.defaultOutputQty || 1);
        const nested = await explodeRecipeVersion(tx, tenantId, subVersion.id, subMultiplier, asOfDate, depth + 1);
        results.push(...nested);
        continue;
      }
      // No approved sub-version found for this combo component - fall
      // through and consume the combo item itself directly as a fallback,
      // rather than silently dropping the line.
    }

    results.push({ ingredientItemId: ing.ingredientItemId, qty: effectiveQty, isPackaging: ing.isPackaging });
  }

  return results;
}

/**
 * Explodes every Modifier recipe attached to a sold sales-invoice line
 * (e.g. "extra cheese", "no onions"), scaled by the modifier's own qty and
 * the line's sold qty. A modifier's ingredient rows carry their own sign -
 * positive to add consumption, negative to reduce it (e.g. "no onions" is
 * authored as a negative onion qty on the Modifier recipe).
 */
export async function explodeLineModifiers(
  tx: Tx,
  tenantId: string,
  salesInvoiceLineId: string,
  soldQty: number,
  asOfDate: Date
): Promise<ExplodedIngredient[]> {
  const modifiers = await tx.salesInvoiceLineModifier.findMany({
    where: { tenantId, salesInvoiceLineId },
    include: { modifierRecipeVersion: { include: { recipe: true } } },
  });

  const results: ExplodedIngredient[] = [];
  for (const mod of modifiers) {
    const multiplier = (soldQty * Number(mod.qty)) / Number(mod.modifierRecipeVersion.recipe.defaultOutputQty || 1);
    const exploded = await explodeRecipeVersion(tx, tenantId, mod.modifierRecipeVersionId, multiplier, asOfDate);
    results.push(...exploded);
  }
  return results;
}

/** Merges exploded ingredient lines that reference the same item so
 * consumption/production posts one movement per item instead of several. */
export function mergeExplodedIngredients(lines: ExplodedIngredient[]): ExplodedIngredient[] {
  const byItem = new Map<string, ExplodedIngredient>();
  for (const line of lines) {
    const existing = byItem.get(line.ingredientItemId);
    if (existing) {
      existing.qty += line.qty;
    } else {
      byItem.set(line.ingredientItemId, { ...line });
    }
  }
  return Array.from(byItem.values());
}
