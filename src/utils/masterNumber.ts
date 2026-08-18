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
 * A manually-typed code always wins, regardless of the series' mode. When
 * nothing was typed: Auto mode fills in the next number; Manual mode
 * returns undefined and leaves the field blank, so the normal "code is
 * required" validation on the create schema catches it with a clear error
 * instead of silently falling back to auto-numbering.
 *
 * Called from crudFactory's create handler via CrudOptions.autoCode - see
 * src/utils/crudFactory.ts.
 */
export async function resolveMasterCode(
  tx: Tx,
  params: { tenantId: string; entityType: string; defaultPrefix: string; providedValue?: string }
): Promise<string | undefined> {
  const { tenantId, entityType, defaultPrefix, providedValue } = params;
  if (providedValue) return providedValue;

  const now = new Date();
  const series = await tx.masterSeries.findFirst({ where: { tenantId, entityType } });

  if (!series) {
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

  if (series.numberingMode === "Manual") return undefined;

  const current = series.nextNo;
  await tx.masterSeries.update({ where: { id: series.id }, data: { nextNo: current + 1 } });

  return formatDocumentNumber(series, current, now);
}
