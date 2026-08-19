import { Prisma, PrismaClient } from "@prisma/client";

type Tx = PrismaClient | Prisma.TransactionClient;

/**
 * Converts a quantity entered in one UOM into another (typically an item's
 * base UOM) using the UomConversion master (src/modules/masters -
 * "UOM conversions" screen). Lets a document line be entered in whatever
 * unit is practical to count in - "10 Box", "3 Carton", "2 Dozen" - while
 * still giving downstream stock/demand logic a real base-unit figure.
 *
 * Lookup order:
 *  1. Same UOM on both sides -> factor 1, no lookup needed.
 *  2. An item-specific UomConversion row (itemId = this item) fromUom->toUom.
 *  3. A generic UomConversion row (itemId = null) fromUom->toUom - shared
 *     conversions like Dozen -> Piece that don't depend on the item.
 *  4. Either of the above stored in reverse (toUom->fromUom) - inverted.
 *
 * Returns null (not a thrown error) when no path is configured, since an
 * unresolvable conversion shouldn't block saving the document - the entered
 * qty/uom is still what's authoritative; baseQty is just left blank for
 * someone to fix by adding the missing UOM Conversion record later.
 */
export async function resolveUomQty(
  tx: Tx,
  params: { tenantId: string; itemId: string; fromUomId: string; toUomId: string; qty: number }
): Promise<number | null> {
  const { tenantId, itemId, fromUomId, toUomId, qty } = params;
  if (fromUomId === toUomId) return qty;

  const forward = await tx.uomConversion.findFirst({
    where: { tenantId, fromUomId, toUomId, OR: [{ itemId }, { itemId: null }] },
    orderBy: { itemId: { sort: "desc", nulls: "last" } },
  });
  if (forward) return qty * Number(forward.factor);

  const reverse = await tx.uomConversion.findFirst({
    where: { tenantId, fromUomId: toUomId, toUomId: fromUomId, OR: [{ itemId }, { itemId: null }] },
    orderBy: { itemId: { sort: "desc", nulls: "last" } },
  });
  if (reverse && Number(reverse.factor) !== 0) return qty / Number(reverse.factor);

  return null;
}
