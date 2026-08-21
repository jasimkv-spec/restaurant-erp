import { Prisma, PrismaClient } from "@prisma/client";

type Tx = PrismaClient | Prisma.TransactionClient;

/** Looks up a control/clearing account by its seeded code, e.g. "AP-CONTROL",
 * "GRN-CLEARING", "TAX-INPUT". Returns null (never throws) so callers can
 * fall back to a posting_exception instead of hard-failing a transaction
 * that is otherwise valid, per the ERD blueprint's exception-queue design. */
export async function resolveCoaByCode(
  tx: Tx,
  tenantId: string,
  companyId: string,
  code: string
) {
  return tx.chartOfAccount.findFirst({ where: { tenantId, companyId, code } });
}

type ItemForGlLookup =
  | {
      glMapping?: {
        inventoryGlId?: string | null;
        cogsGlId?: string | null;
        revenueGlId?: string | null;
        expenseGlId?: string | null;
        wastageGlId?: string | null;
      } | null;
      category?: {
        defaultInventoryGlId?: string | null;
        defaultCogsGlId?: string | null;
      } | null;
    }
  | null
  | undefined;

/** Resolves which GL account to post an item's movement against, in priority
 * order: the item's own GL mapping (set on the item's "Account mapping"
 * panel) first, then its category's default account, then the company-wide
 * control account as a last resort. This lets most items just inherit their
 * category's accounting treatment, while any item that needs its own
 * treatment can override it directly - never the other way round. */
export async function resolveItemGl(
  tx: Tx,
  tenantId: string,
  companyId: string,
  item: ItemForGlLookup,
  field: "inventoryGlId" | "cogsGlId" | "revenueGlId" | "expenseGlId" | "wastageGlId",
  fallbackCode: string
) {
  const itemGlId = item?.glMapping?.[field];
  if (itemGlId) {
    const acct = await tx.chartOfAccount.findUnique({ where: { id: itemGlId } });
    if (acct) return acct;
  }
  if (field === "inventoryGlId" || field === "cogsGlId") {
    const categoryGlId =
      field === "inventoryGlId" ? item?.category?.defaultInventoryGlId : item?.category?.defaultCogsGlId;
    if (categoryGlId) {
      const acct = await tx.chartOfAccount.findUnique({ where: { id: categoryGlId } });
      if (acct) return acct;
    }
  }
  return resolveCoaByCode(tx, tenantId, companyId, fallbackCode);
}
