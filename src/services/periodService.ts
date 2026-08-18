import { Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "../utils/errors";
import { resolvePolicy } from "./policyRuleService";

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
 *
 * The block can be lifted per branch/user/role via a "PriorYearTransaction"
 * PolicyRule (Company Policies screen) - e.g. a Finance Manager role can
 * be granted the ability to post into a closed period while everyone else
 * stays blocked. userId is optional because not every caller has a user
 * threaded through yet (see stockService.ts) - without it, only
 * company-wide/branch-wide override rules can apply, not per-user ones.
 */
export async function assertPeriodOpen(
  tx: Tx,
  params: {
    tenantId: string;
    companyId: string;
    branchId?: string | null;
    userId?: string | null;
    date: Date;
    kind: "Finance" | "Inventory";
  }
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
    const override = await resolvePolicy(tx, {
      tenantId: params.tenantId,
      companyId: params.companyId,
      branchId: params.branchId,
      userId: params.userId,
      policyType: "PriorYearTransaction",
      defaultAllow: false,
      defaultValue: null,
    });
    if (override.allow) return;

    const label = `${period.fiscalYear}-${String(period.monthNo).padStart(2, "0")}`;
    throw ApiError.badRequest(
      `${params.kind} period ${label} is ${status} - posting not allowed. Reopen it under Admin > Financial Periods first, or grant a PriorYearTransaction policy override.`
    );
  }
}
