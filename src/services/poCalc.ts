import { Prisma, PrismaClient } from "@prisma/client";

type Tx = PrismaClient | Prisma.TransactionClient;

export interface PoLineInput {
  itemId: string;
  qty: number;
  uomId: string;
  unitPrice: number;
  taxId?: string;
  discountPct?: number;
  discountAmount?: number;
  focQty?: number;
  isFocLine?: boolean;
  instructions?: string;
  sourceMrId?: string;
  sourceMrLineId?: string;
  sourceRfqLineId?: string;
}

export interface PoLineComputed extends PoLineInput {
  focQty: number;
  isFocLine: boolean;
  taxAmount: number;
  lineTotal: number;
  // This line's share of the header-level discount, prorated by its share of
  // the pre-header-discount subtotal. Kept separate from the line's own
  // discountPct/discountAmount (its independently negotiated discount).
  headerDiscountShare: number;
}

export interface PoTotals {
  lines: PoLineComputed[];
  totalAmount: number;
}

/**
 * Shared line-amount math for Purchase Orders, used by both the manual
 * create/edit routes and RFQ's convert-to-po (so a PO looks and totals the
 * same no matter how it was created).
 *
 * Order of operations per line: gross (qty x price, 0 if isFocLine) -> less
 * this line's own negotiated discount -> less this line's prorated share of
 * the PO header's overall discount (allocated by each line's share of the
 * subtotal, so a header "500 AED off" or "5% off everything" actually shows
 * up spread across the lines it's costing-relevant to) -> tax on what's left
 * (skipped entirely when taxMode is "Exempt", regardless of the line's own
 * taxId) -> lineTotal. focQty never affects amounts - it's purely a receiving
 * quantity for GRN to track later.
 */
export async function computePoLineAmounts(
  tx: Tx,
  tenantId: string,
  header: { taxMode: "Vatable" | "Exempt"; discountPct?: number; discountAmount?: number },
  lines: PoLineInput[]
): Promise<PoTotals> {
  const taxIds = Array.from(new Set(lines.map((l) => l.taxId).filter((id): id is string => !!id)));
  const taxes = taxIds.length
    ? await tx.tax.findMany({ where: { id: { in: taxIds }, tenantId } })
    : [];
  const taxRateById = new Map(taxes.map((t) => [t.id, Number(t.rate)]));

  const netByLine = lines.map((l) => {
    const gross = l.isFocLine ? 0 : l.qty * l.unitPrice;
    const lineDiscount = l.discountAmount ?? (l.discountPct ? (gross * l.discountPct) / 100 : 0);
    return Math.max(0, gross - lineDiscount);
  });
  const subtotal = netByLine.reduce((sum, n) => sum + n, 0);

  const headerDiscountAmount = header.discountAmount ?? (header.discountPct ? (subtotal * header.discountPct) / 100 : 0);

  const computedLines: PoLineComputed[] = lines.map((l, i) => {
    const net = netByLine[i];
    const headerShare = subtotal > 0 ? (net / subtotal) * headerDiscountAmount : 0;
    const taxable = Math.max(0, net - headerShare);
    const rate = l.taxId ? taxRateById.get(l.taxId) ?? 0 : 0;
    const taxAmount = header.taxMode === "Exempt" ? 0 : (taxable * rate) / 100;
    const lineTotal = taxable + taxAmount;
    return {
      ...l,
      focQty: l.focQty ?? 0,
      isFocLine: l.isFocLine ?? false,
      taxAmount,
      lineTotal,
      headerDiscountShare: headerShare,
    };
  });

  const totalAmount = computedLines.reduce((sum, l) => sum + l.lineTotal, 0);

  return { lines: computedLines, totalAmount };
}
