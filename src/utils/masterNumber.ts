import { Prisma, PrismaClient } from "@prisma/client";
import { formatDocumentNumber } from "./documentNumber";

type Tx = PrismaClient | Prisma.TransactionClient;

/**
 * Resolves the code for a master-data record (Vendors, Customers, and
 * later Employees) the same way nextDocumentNumber() resolves transaction
 * numbers - e.g. entityType="Vendor" with prefix "SUP" and digitLength 4
 * produces "SUP0001", "SUP0002", etc.
 *
 * Deliberately a separate table from document_series: document numbering
 * is scoped per company (and sometimes per branch) because two branches
 * may want independent PO sequences, but master-data codes are shared
 * tenant-wide - a vendor or customer code should not repeat just because
 * they were first entered against a different company.
 *
 * Whether a manually-typed code is honored depends on whether a series is
 * actually configured for this entityType, and in what mode:
 *  - No series configured at all -> nothing to auto-generate from, so a
 *    typed value always wins (and if none was typed, one gets generated
 *    from defaultPrefix and a series is created in Auto mode so it's
 *    visible in the Master Series screen from then on).
 *  - Series configured, mode Manual -> a typed value always wins; if
 *    nothing was typed, returns undefined and leaves the field blank, so
 *    the normal "code is required" validation on the create schema catches
 *    it with a clear error instead of silently falling back to
 *    auto-numbering.
 *  - Series configured, mode Auto -> always generates the next number,
 *    ignoring any typed value. The frontend already locks the code field
 *    from manual entry in this case (see useCodeLock.ts) - this is the
 *    server-side half of that guarantee, so numbering can't be bypassed or
 *    thrown out of sync by a stray manual value reaching the API directly.
 *
 * Called from crudFactory's create handler via CrudOptions.autoCode - see
 * src/utils/crudFactory.ts.
 */
export async function resolveMasterCode(
  tx: Tx,
  params: { tenantId: string; entityType: string; defaultPrefix: string; providedValue?: string }
): Promise<string | undefined> {
  const { tenantId, entityType, defaultPrefix, providedValue } = params;

  const now = new Date();
  const series = await tx.masterSeries.findFirst({ where: { tenantId, entityType } });

  if (!series) {
    if (providedValue) return providedValue;
    // No series configured yet - Auto is the default, so create one and
    // hand back the first number.
    await tx.masterSeries.create({
      data: { tenantId, entityType, prefix: defaultPrefix, nextNo: 2 },
    });
    return formatDocumentNumber(
      {
        prefix: defaultPrefix,
        nextNo: 1,
        digitLength: 4,
        padChar: "0",
        separator: "",
        includeYear: false,
        yearFormat: "YYYY",
        includeMonth: false,
      },
      1,
      now
    );
  }

  if (series.numberingMode === "Manual") return providedValue;

  const current = series.nextNo;
  await tx.masterSeries.update({ where: { id: series.id }, data: { nextNo: current + 1 } });

  return formatDocumentNumber(series, current, now);
}
