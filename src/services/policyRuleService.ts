import { Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "../utils/errors";

type Tx = PrismaClient | Prisma.TransactionClient;

export interface ResolvedPolicy {
  allow: boolean;
  value: number | null;
}

/**
 * The scoped policy engine behind the Company Policies screen - see
 * prisma/schema.prisma's PolicyRule model. A tenant/company can have many
 * rules for the same policyType, each narrowed to a specific branch,
 * user, and/or role (null in any of those columns means "applies to
 * All"). This picks the single most relevant rule for the request at
 * hand: an exact user match beats a role match, which beats a branch
 * match, which beats a company-wide default. Ties at the same
 * specificity are broken in favour of the more restrictive (allow=false)
 * rule, since a permission system should never silently pick the more
 * permissive option when it's ambiguous which rule "wins".
 *
 * If nothing matches at all (no admin has touched this policyType for
 * this company yet), the caller's default is used - every call site
 * passes a default that matches today's actual behaviour, so rolling
 * this out doesn't change anything for a tenant until they visit Company
 * Policies and add a rule.
 */
export async function resolvePolicy(
  tx: Tx,
  params: {
    tenantId: string;
    companyId: string;
    branchId?: string | null;
    userId?: string | null;
    policyType: string;
    defaultAllow: boolean;
    defaultValue?: number | null;
  }
): Promise<ResolvedPolicy> {
  const { tenantId, companyId, branchId = null, userId = null, policyType } = params;

  const roleIds = userId
    ? (
        await tx.userRole.findMany({ where: { tenantId, userId }, select: { roleId: true } })
      ).map((r) => r.roleId)
    : [];

  const candidates = await tx.policyRule.findMany({
    where: { tenantId, companyId, policyType },
  });

  const applicable = candidates.filter(
    (r) =>
      (r.userId === null || r.userId === userId) &&
      (r.roleId === null || roleIds.includes(r.roleId)) &&
      (r.branchId === null || r.branchId === branchId)
  );

  if (applicable.length === 0) {
    return { allow: params.defaultAllow, value: params.defaultValue ?? null };
  }

  const specificity = (r: (typeof applicable)[number]) =>
    (r.userId ? 4 : 0) + (r.roleId ? 2 : 0) + (r.branchId ? 1 : 0);

  const maxSpecificity = Math.max(...applicable.map(specificity));
  const topTier = applicable.filter((r) => specificity(r) === maxSpecificity);
  const chosen = topTier.find((r) => !r.allow) ?? topTier[0];

  return { allow: chosen.allow, value: chosen.value !== null ? Number(chosen.value) : null };
}

/**
 * Blocks a transaction date that falls outside what BackdatedTransaction /
 * PostdatedTransaction policy rules allow for this scope. Defaults to
 * "unrestricted" (today's actual behaviour) when nothing's configured, so
 * this is safe to call from every posting choke point without changing
 * behaviour for tenants who haven't set up these policies.
 */
export async function assertDateAllowed(
  tx: Tx,
  params: { tenantId: string; companyId: string; branchId?: string | null; userId?: string | null; date: Date }
) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const target = new Date(params.date);
  target.setUTCHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);

  if (diffDays < 0) {
    const policy = await resolvePolicy(tx, {
      ...params,
      policyType: "BackdatedTransaction",
      defaultAllow: true,
      defaultValue: null,
    });
    if (!policy.allow) {
      throw ApiError.badRequest("Backdated entries are not allowed for this company's policy.");
    }
    if (policy.value !== null && Math.abs(diffDays) > policy.value) {
      throw ApiError.badRequest(
        `Date is ${Math.abs(diffDays)} day(s) in the past, which exceeds the allowed limit of ${policy.value} day(s).`
      );
    }
  } else if (diffDays > 0) {
    const policy = await resolvePolicy(tx, {
      ...params,
      policyType: "PostdatedTransaction",
      defaultAllow: true,
      defaultValue: null,
    });
    if (!policy.allow) {
      throw ApiError.badRequest("Post-dated entries are not allowed for this company's policy.");
    }
    if (policy.value !== null && diffDays > policy.value) {
      throw ApiError.badRequest(
        `Date is ${diffDays} day(s) in the future, which exceeds the allowed limit of ${policy.value} day(s).`
      );
    }
  }
}

/**
 * Checks a set of sale lines (and an optional header discount) against
 * the PriceEditing, SellBelowCost, and DiscountEditing policies. All
 * three default to allow=true (today's actual behaviour: prices and
 * discounts are free-entry with no comparison against anything), so
 * calling this is a no-op until a company explicitly restricts one of
 * these from the Company Policies screen.
 */
export async function assertPricingAllowed(
  tx: Tx,
  params: {
    tenantId: string;
    companyId: string;
    branchId?: string | null;
    userId?: string | null;
    lines: { itemId: string; unitPrice: number }[];
    discountPct?: number;
  }
) {
  const { tenantId, branchId } = params;

  const [priceEditPolicy, sellBelowCostPolicy] = await Promise.all([
    resolvePolicy(tx, { ...params, policyType: "PriceEditing", defaultAllow: true, defaultValue: null }),
    resolvePolicy(tx, { ...params, policyType: "SellBelowCost", defaultAllow: true, defaultValue: null }),
  ]);

  if (priceEditPolicy.allow && sellBelowCostPolicy.allow) {
    // Neither restriction is active - skip the per-line item lookups.
  } else {
    for (const line of params.lines) {
      const item = await tx.item.findUnique({
        where: { id: line.itemId },
        select: { name: true, averageCost: true, lastReceivedCost: true },
      });
      if (!item) continue;

      if (!sellBelowCostPolicy.allow) {
        const cost = item.averageCost ?? item.lastReceivedCost;
        if (cost !== null && line.unitPrice < Number(cost)) {
          throw ApiError.badRequest(
            `Selling "${item.name}" at ${line.unitPrice} is below its cost (${Number(cost).toFixed(2)}) and this company's policy disallows that.`
          );
        }
      }

      if (!priceEditPolicy.allow) {
        const prices = await tx.itemPrice.findMany({
          where: { tenantId, itemId: line.itemId },
          orderBy: { effectiveFrom: "desc" },
        });
        const listPrice = prices.find((p) => p.branchId === branchId) ?? prices.find((p) => p.branchId === null) ?? prices[0];
        if (listPrice && Math.abs(Number(listPrice.price) - line.unitPrice) > 0.001) {
          throw ApiError.badRequest(
            `"${item.name}" price ${line.unitPrice} does not match the list price ${Number(listPrice.price)} and this company's policy disallows editing price.`
          );
        }
      }
    }
  }

  if (params.discountPct !== undefined && params.discountPct > 0) {
    const discountPolicy = await resolvePolicy(tx, {
      ...params,
      policyType: "DiscountEditing",
      defaultAllow: true,
      defaultValue: null,
    });
    if (!discountPolicy.allow) {
      throw ApiError.badRequest("Discounts are not allowed by this company's policy.");
    }
    if (discountPolicy.value !== null && params.discountPct > discountPolicy.value) {
      throw ApiError.badRequest(
        `Discount of ${params.discountPct}% exceeds the allowed maximum of ${discountPolicy.value}%.`
      );
    }
  }
}
