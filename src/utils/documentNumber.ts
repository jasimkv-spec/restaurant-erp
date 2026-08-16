import { Prisma, PrismaClient } from "@prisma/client";

type Tx = PrismaClient | Prisma.TransactionClient;

interface SeriesFormat {
  prefix: string;
  nextNo: number;
  digitLength: number;
  padChar: string;
  separator: string;
  includeYear: boolean;
  yearFormat: string; // "YYYY" | "YY"
  includeMonth: boolean;
}

/** Builds the human-readable number for a series, e.g. "PO-2026-08-000012"
 * for prefix=PO, includeYear+includeMonth on, digitLength=6, padChar="0". */
function formatDocumentNumber(series: SeriesFormat, serialValue: number, now: Date): string {
  const parts = [series.prefix];
  if (series.includeYear) {
    const year = now.getUTCFullYear();
    parts.push(series.yearFormat === "YY" ? String(year).slice(-2) : String(year));
  }
  if (series.includeMonth) {
    parts.push(String(now.getUTCMonth() + 1).padStart(2, "0"));
  }
  const pad = series.padChar && series.padChar.length === 1 ? series.padChar : "0";
  parts.push(String(serialValue).padStart(series.digitLength, pad));
  return parts.filter(Boolean).join(series.separator ?? "-");
}

/**
 * Atomically allocates the next document number for a module, per the
 * document_series model (BRD 5.1: "Company policies for ... document
 * numbering"). Creates a default series (prefix = moduleCode, 6-digit
 * zero-padded serial, no year/month segment) on first use so the MVP works
 * without manual setup. Admins can reconfigure digit length, padding
 * character, separator, and year/month segments per series via
 * PUT /api/admin/document-series/:id.
 *
 * Note: resetPolicy (Never/Yearly/Monthly) is stored but not yet enforced
 * here - nextNo always increments. Wiring the actual reset (comparing the
 * series' last-issued year/month to `now` and zeroing nextNo when it rolls
 * over) is a small follow-up once a "last issued at" column is added.
 */
export async function nextDocumentNumber(
  tx: Tx,
  params: {
    tenantId: string;
    companyId: string;
    branchId?: string | null;
    moduleCode: string;
    defaultPrefix?: string;
  }
): Promise<string> {
  const { tenantId, companyId, branchId = null, moduleCode } = params;
  const defaultPrefix = params.defaultPrefix ?? moduleCode.slice(0, 3).toUpperCase();
  const now = new Date();

  const series = await tx.documentSeries.findFirst({
    where: { tenantId, companyId, branchId, moduleCode },
  });

  if (!series) {
    await tx.documentSeries.create({
      data: { tenantId, companyId, branchId, moduleCode, prefix: defaultPrefix, nextNo: 2 },
    });
    return formatDocumentNumber(
      { prefix: defaultPrefix, nextNo: 1, digitLength: 6, padChar: "0", separator: "-", includeYear: false, yearFormat: "YYYY", includeMonth: false },
      1,
      now
    );
  }

  const current = series.nextNo;
  await tx.documentSeries.update({ where: { id: series.id }, data: { nextNo: current + 1 } });

  return formatDocumentNumber(series, current, now);
}
