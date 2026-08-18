import { Prisma, PrismaClient } from "@prisma/client";
import { formatDocumentNumber } from "./documentNumber";

type Tx = PrismaClient | Prisma.TransactionClient;

/**
 * Auto-generates codes for master-data records (Vendors, Customers, and
 * later Employees) the same way nextDocumentNumber() generates transaction
 * numbers - e.g. entityType="Vendor" with prefix "SUP" and digitLength 4
 * produces "SUP0001", "SUP0002", etc.
 *
 * Deliberately a separate table from document_series: document numbering
 * is scoped per company (and sometimes per branch) because two branches
 * may want independent PO sequences, but master-data codes are shared
 * tenant-wide - a vendor or customer code should not repeat just because
 * they were first entered against a different company.
 *
 * Called from crudFactory's create handler via CrudOptions.autoCode - see
 * src/utils/crudFactory.ts. Only fills the code in when the caller left
 * the field blank, so manual codes still work if someone wants full
 * control instead of the auto-series.
 */
export async function nextMasterNumber(
  tx: Tx,
  params: { tenantId: string; entityType: string; defaultPrefix: string }
): Promise<string> {
  const { tenantId, entityType, defaultPrefix } = params;
  const now = new Date();

  const series = await tx.masterSeries.findFirst({ where: { tenantId, entityType } });

  if (!series) {
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

  const current = series.nextNo;
  await tx.masterSeries.update({ where: { id: series.id }, data: { nextNo: current + 1 } });

  return formatDocumentNumber(series, current, now);
}
