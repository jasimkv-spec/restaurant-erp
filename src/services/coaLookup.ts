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
