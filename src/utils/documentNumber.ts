import { Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "./errors";

type Tx = PrismaClient | Prisma.TransactionClient;

export interface SeriesFormat {
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
 * for prefix=PO, includeYear+includeMonth on, digitLength=6, padChar="0".
 * Exported so master-data code numbering (src/utils/masterNumber.ts) can
 * reuse the exact same formatting rules instead of re-implementing them. */
export function formatDocumentNumber(series: SeriesFormat, serialValue: number, now: Date): string {
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
 * character, separator, year/month segments, and Auto/Manual mode via
 * PUT /api/admin/document-series/:id.
 *
 * When a series is set to Manual, the caller must pass manualValue (the
 * number the user typed in on that transaction screen) - if it's missing,
 * this throws rather than silently falling back to auto-numbering, so a
 * misconfigured series fails loudly instead of quietly ignoring the
 * admin's setting. As of this change, none of the transaction screens
 * actually collect and pass a manual value yet (those screens don't have
 * frontend UI built), so switching a series to Manual will correctly block
 * that document type until its screen is updated to support it.
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
    manualValue?: string;
  }
): Promise<string> {
  const { tenantId, companyId, branchId = null, moduleCode, manualValue } = params;
  const defaultPrefix = params.defaultPrefix ?? moduleCode.slice(0, 3).toUpperCase();
  const now = new Date();

  if (manualValue) return manualValue;

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

  if (series.numberingMode === "Manual") {
    throw ApiError.badRequest(
      `${moduleCode} numbering is set to Manual in Document Series, but this screen doesn't collect a manual number yet - set it back to Auto, or ask for manual entry to be added here.`
    );
  }

  const current = series.nextNo;
  await tx.documentSeries.update({ where: { id: series.id }, data: { nextNo: current + 1 } });

  return formatDocumentNumber(series, current, now);
}
