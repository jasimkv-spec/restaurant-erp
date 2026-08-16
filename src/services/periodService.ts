import { Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "../utils/errors";

type Tx = PrismaClient | Prisma.TransactionClient;

const OPEN_STATUSES = new Set(["Open", "Reopened"]);

/**
 * Enforces BRD 5.1's period-close control: once a financial period's
 * financeStatus/inventoryStatus is moved out of Open (or Reopened) -
 * Soft Closed, Closed, or Locked - no new postings may hit that period.
 * Admin > Financial Periods (Admin.FinancialPeriod, plain CRUD) is where a
 * period's status actually gets changed; this function is what makes that
 * status mean something.
 *
 * Called from the two universal posting choke points - postJournal() for
 * financeStatus, postStockMovement() for inventoryStatus - rather than
 * from each of the ~20 individual transaction endpoints that eventually
 * call them, so there is exactly one place this check can be missed
 * instead of twenty.
 *
 * A company/date with no matching FinancialPeriod row is treated as open.
 * Most demo/setup companies won't have every future month pre-seeded, and
 * an unconfigured period should not silently block every transaction -
 * enforcement only kicks in once you've actually defined that month under
 * Admin > Financial Periods.
 */
export async function assertPeriodOpen(
  tx: Tx,
  params: { tenantId: string; companyId: string; date: Date; kind: "Finance" | "Inventory" }
) {
  const period = await tx.financialPeriod.findFirst({
    where: {
      tenantId: params.tenantId,
      companyId: params.companyId,
      startDate: { lte: params.date },
      endDate: { gte: params.date },
    },
  });
  if (!period) return;

  const status = params.kind === "Finance" ? period.financeStatus : period.inventoryStatus;
  if (!OPEN_STATUSES.has(status)) {
    const label = `${period.fiscalYear}-${String(period.monthNo).padStart(2, "0")}`;
    throw ApiError.badRequest(
      `${params.kind} period ${label} is ${status} - posting not allowed. Reopen it under Admin > Financial Periods first.`
    );
  }
}
