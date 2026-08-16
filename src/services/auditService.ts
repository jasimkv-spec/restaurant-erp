import { Prisma, PrismaClient } from "@prisma/client";

type Tx = PrismaClient | Prisma.TransactionClient;

export interface AuditLogInput {
  tenantId: string;
  userId?: string | null;
  moduleCode: string;
  recordTable: string;
  recordId: string;
  action: "Created" | "Edited" | "Submitted" | "Approved" | "Rejected" | "Posted" | "Cancelled" | "Reopened" | "Activated" | "Deactivated";
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * Writes one audit_logs row (BRD Security 5.2/10.1: "audit trail"). Never
 * throws - a failed audit write should never roll back or block the
 * business transaction it's describing, so this swallows errors after
 * logging to stderr rather than propagating them. Called from two kinds
 * of places:
 *
 * 1. The two universal posting choke points - postJournal() and
 *    postStockMovement() - which already touch every GL/stock-affecting
 *    document across every module, the same way assertPeriodOpen() does
 *    for period-close enforcement. That alone covers GRN, Purchase
 *    Invoice, Vendor Payment, Sales Invoice, Consumption, Production
 *    Posting, Stock Transfer, Stock Adjustment, Contra Voucher, Customer
 *    Receipt, Credit/Debit Notes, and manual Journal Entries.
 * 2. src/utils/crudFactory.ts's create/update/(de)activate actions, which
 *    covers every master-data screen built on the generic CRUD router.
 *
 * Lifecycle actions outside those two categories (submit/approve on
 * Material Request, Purchase Order, Stock Transfer, Stock Adjustment, and
 * approval-task decisions) are logged individually at their call sites
 * since they don't flow through either choke point.
 */
export async function writeAuditLog(tx: Tx, input: AuditLogInput) {
  try {
    await tx.auditLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId ?? null,
        moduleCode: input.moduleCode,
        recordTable: input.recordTable,
        recordId: input.recordId,
        action: input.action,
        oldValueJson: input.oldValue === undefined ? undefined : (input.oldValue as any),
        newValueJson: input.newValue === undefined ? undefined : (input.newValue as any),
      },
    });
  } catch (err) {
    console.error("writeAuditLog failed (non-fatal):", err);
  }
}
