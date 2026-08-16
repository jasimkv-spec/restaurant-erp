import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { crudRouter } from "../../utils/crudFactory";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePermission } from "../../middleware/rbac";
import { ApiError } from "../../utils/errors";
import { postJournal } from "../../services/journalService";

const router = Router();

// --- Account Groups -----------------------------------------------------------
// Financial-statement classification (e.g. "Current Assets", "Direct
// Income") - separate from an account's own parent/child nesting. Every
// group's natureType determines which statement it rolls into: Asset,
// Liability, and Equity groups feed the Balance Sheet; Revenue and Expense
// groups feed the Profit and Loss.
router.use(
  "/account-groups",
  crudRouter(prisma.accountGroup, {
    permissionKey: "Finance.AccountGroup",
    createSchema: z.object({
      code: z.string().min(1).max(30),
      name: z.string().min(1),
      natureType: z.enum(["Asset", "Liability", "Equity", "Revenue", "Expense"]),
      parentGroupId: z.string().uuid().optional(),
      sortOrder: z.number().int().default(0),
    }),
    include: { parentGroup: true },
  })
);

// --- Chart of Accounts -----------------------------------------------------------
router.use(
  "/chart-of-accounts",
  crudRouter(prisma.chartOfAccount, {
    permissionKey: "Finance.ChartOfAccount",
    createSchema: z.object({
      companyId: z.string().uuid(),
      code: z.string().min(1).max(50),
      name: z.string().min(1),
      accountType: z.enum(["Asset", "Liability", "Equity", "Revenue", "Expense"]),
      groupId: z.string().uuid().optional(),
      parentId: z.string().uuid().optional(),
      isControlAccount: z.boolean().default(false),
    }),
    include: { group: true, parent: true },
  })
);

// --- Bank Accounts -----------------------------------------------------------
router.use(
  "/bank-accounts",
  crudRouter(prisma.bankAccount, {
    permissionKey: "Finance.BankAccount",
    createSchema: z.object({
      companyId: z.string().uuid(),
      accountId: z.string().uuid(),
      bankName: z.string().min(1),
      accountNoMasked: z.string().optional(),
    }),
  })
);

// --- Cheque Register -----------------------------------------------------------
// The cheque itself is created as part of a VendorPayment/CustomerReceipt
// over in Accounting (paymentMethod = a "Cheque"-type PaymentMethod, plus
// chequeNo/chequeDate on the voucher) - this is the control view over those
// cheques plus the one GL-affecting event a cheque register needs to
// handle: a bounced cheque reverses the original posting.
router.get(
  "/cheque-register",
  requirePermission("Finance.ChequeRegister.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;

    const [issued, received] = await Promise.all([
      prisma.vendorPayment.findMany({
        where: { tenantId, chequeNo: { not: null }, ...(status ? { chequeStatus: status } : {}) },
        include: { vendor: true },
        orderBy: { chequeDate: "desc" },
      }),
      prisma.customerReceipt.findMany({
        where: { tenantId, chequeNo: { not: null }, ...(status ? { chequeStatus: status } : {}) },
        include: { customer: true },
        orderBy: { chequeDate: "desc" },
      }),
    ]);

    const data = [
      ...issued.map((p) => ({
        direction: "Issued",
        voucherType: "VendorPayment",
        voucherId: p.id,
        voucherNo: p.paymentNo,
        partyName: p.vendor.name,
        chequeNo: p.chequeNo,
        chequeDate: p.chequeDate,
        amount: Number(p.amount),
        chequeStatus: p.chequeStatus,
        postingStatus: p.postingStatus,
      })),
      ...received.map((r) => ({
        direction: "Received",
        voucherType: "CustomerReceipt",
        voucherId: r.id,
        voucherNo: r.receiptNo,
        partyName: r.customer.name,
        chequeNo: r.chequeNo,
        chequeDate: r.chequeDate,
        amount: Number(r.amount),
        chequeStatus: r.chequeStatus,
        postingStatus: r.postingStatus,
      })),
    ].sort((a, b) => (b.chequeDate?.getTime() ?? 0) - (a.chequeDate?.getTime() ?? 0));

    res.json({ data });
  })
);

/**
 * Updates a cheque's status. Cleared/Cancelled are register-only changes -
 * clearing is a bank-side confirmation, the GL entry was already made when
 * the voucher was posted. Bounced is the one status that reverses the
 * original GL posting (Dr/Cr swapped) and reopens the voucher to Draft so
 * it can be corrected or reissued - a bounced cheque means the cash never
 * actually moved.
 */
router.post(
  "/cheque-register/:voucherType/:id/status",
  requirePermission("Finance.ChequeRegister.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const { voucherType, id } = req.params;
    if (voucherType !== "vendor-payment" && voucherType !== "customer-receipt") {
      throw ApiError.badRequest("voucherType must be vendor-payment or customer-receipt");
    }
    const schema = z.object({ status: z.enum(["Cleared", "Bounced", "Cancelled"]), companyId: z.string().uuid() });
    const { status, companyId } = schema.parse(req.body);
    const isVendorPayment = voucherType === "vendor-payment";

    const voucher = isVendorPayment
      ? await prisma.vendorPayment.findFirst({ where: { id, tenantId } })
      : await prisma.customerReceipt.findFirst({ where: { id, tenantId } });
    if (!voucher) throw ApiError.notFound();
    if (!voucher.chequeNo) throw ApiError.badRequest("This voucher has no cheque number - not a cheque payment");
    if (voucher.chequeStatus === "Bounced" || voucher.chequeStatus === "Cancelled") {
      throw ApiError.badRequest(`Cheque already ${voucher.chequeStatus}`);
    }
    if (status === "Cancelled" && voucher.postingStatus === "Posted") {
      throw ApiError.badRequest("Posted cheque cannot be cancelled - mark it Bounced instead, which reverses the posting");
    }

    await prisma.$transaction(async (tx) => {
      const reopening = status === "Bounced" && voucher.postingStatus === "Posted";

      if (reopening) {
        const original = await tx.journalEntry.findFirst({
          where: { tenantId, sourceDocId: voucher.id, status: "Posted" },
          include: { lines: true },
        });
        if (original) {
          await postJournal(tx, {
            tenantId,
            companyId,
            sourceModule: "Finance",
            sourceDocId: voucher.id,
            journalDate: new Date(),
            lines: original.lines.map((l) => ({
              accountId: l.accountId,
              debit: Number(l.credit),
              credit: Number(l.debit),
              branchId: l.branchId,
              costCentreId: l.costCentreId,
              profitCentreId: l.profitCentreId,
            })),
          });
        }
      }

      if (isVendorPayment) {
        await tx.vendorPayment.update({
          where: { id },
          data: reopening ? { chequeStatus: status, postingStatus: "Draft" } : { chequeStatus: status },
        });
      } else {
        await tx.customerReceipt.update({
          where: { id },
          data: reopening ? { chequeStatus: status, postingStatus: "Draft" } : { chequeStatus: status },
        });
      }
    });

    const updated = isVendorPayment
      ? await prisma.vendorPayment.findUnique({ where: { id } })
      : await prisma.customerReceipt.findUnique({ where: { id } });
    res.json(updated);
  })
);

// --- Bank Reconciliation -----------------------------------------------------
// MVP scope is manual statement entry (no live bank feed): each imported
// line gets matched against a posted VendorPayment/CustomerReceipt/
// ContraVoucher that hit the same bank account. Book vs statement balance
// and both sides' unmatched items are the actual reconciliation - see
// GET /reports/bank-reconciliation below.
router.post(
  "/bank-statement-lines",
  requirePermission("Finance.BankStatementLine.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      bankAccountId: z.string().uuid(),
      lineDate: z.coerce.date(),
      description: z.string().optional(),
      amount: z.number(),
    });
    const payload = schema.parse(req.body);
    const record = await prisma.bankStatementLine.create({ data: { tenantId, ...payload } });
    res.status(201).json(record);
  })
);

router.get(
  "/bank-statement-lines",
  requirePermission("Finance.BankStatementLine.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ bankAccountId: z.string().uuid(), reconciled: z.coerce.boolean().optional() });
    const { bankAccountId, reconciled } = schema.parse(req.query);
    const items = await prisma.bankStatementLine.findMany({
      where: { tenantId, bankAccountId, ...(reconciled !== undefined ? { reconciled } : {}) },
      orderBy: { lineDate: "desc" },
    });
    res.json({ data: items });
  })
);

router.post(
  "/bank-statement-lines/:id/match",
  requirePermission("Finance.BankStatementLine.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      voucherType: z.enum(["VendorPayment", "CustomerReceipt", "ContraVoucher"]),
      voucherId: z.string().uuid(),
    });
    const { voucherType, voucherId } = schema.parse(req.body);

    const line = await prisma.bankStatementLine.findFirst({ where: { id: req.params.id, tenantId } });
    if (!line) throw ApiError.notFound();

    const voucherExists =
      voucherType === "VendorPayment"
        ? await prisma.vendorPayment.findFirst({ where: { id: voucherId, tenantId, postingStatus: "Posted" } })
        : voucherType === "CustomerReceipt"
        ? await prisma.customerReceipt.findFirst({ where: { id: voucherId, tenantId, postingStatus: "Posted" } })
        : await prisma.contraVoucher.findFirst({ where: { id: voucherId, tenantId, status: "Posted" } });
    if (!voucherExists) throw ApiError.badRequest("Voucher not found or not posted");

    const updated = await prisma.bankStatementLine.update({
      where: { id: line.id },
      data: { reconciled: true, matchedVoucherType: voucherType, matchedVoucherId: voucherId },
    });
    res.json(updated);
  })
);

router.post(
  "/bank-statement-lines/:id/unmatch",
  requirePermission("Finance.BankStatementLine.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const line = await prisma.bankStatementLine.findFirst({ where: { id: req.params.id, tenantId } });
    if (!line) throw ApiError.notFound();
    const updated = await prisma.bankStatementLine.update({
      where: { id: line.id },
      data: { reconciled: false, matchedVoucherType: null, matchedVoucherId: null },
    });
    res.json(updated);
  })
);

router.get(
  "/reports/bank-reconciliation",
  requirePermission("Finance.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ bankAccountId: z.string().uuid(), asOfDate: z.coerce.date().optional() });
    const { bankAccountId, asOfDate = new Date() } = schema.parse(req.query);

    const bankAccount = await prisma.bankAccount.findFirst({ where: { id: bankAccountId, tenantId } });
    if (!bankAccount) throw ApiError.notFound();

    const [glLines, statementLines] = await Promise.all([
      prisma.journalLine.findMany({
        where: { tenantId, accountId: bankAccount.accountId, journal: { status: "Posted", journalDate: { lte: asOfDate } } },
      }),
      prisma.bankStatementLine.findMany({ where: { tenantId, bankAccountId, lineDate: { lte: asOfDate } } }),
    ]);

    const bookBalance = glLines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    const statementBalance = statementLines.reduce((s, l) => s + Number(l.amount), 0);

    const unreconciledStatementLines = statementLines.filter((l) => !l.reconciled);

    const [postedPayments, postedReceipts, postedContras] = await Promise.all([
      prisma.vendorPayment.findMany({ where: { tenantId, bankAccountId, postingStatus: "Posted" } }),
      prisma.customerReceipt.findMany({ where: { tenantId, bankAccountId, postingStatus: "Posted" } }),
      prisma.contraVoucher.findMany({
        where: { tenantId, status: "Posted", OR: [{ fromBankAccountId: bankAccountId }, { toBankAccountId: bankAccountId }] },
      }),
    ]);
    const matchedIds = new Set(statementLines.filter((l) => l.reconciled).map((l) => l.matchedVoucherId));
    const outstandingVouchers = [
      ...postedPayments.filter((p) => !matchedIds.has(p.id)).map((p) => ({ voucherType: "VendorPayment", voucherId: p.id, voucherNo: p.paymentNo, date: p.paymentDate, amount: -Number(p.amount) })),
      ...postedReceipts.filter((r) => !matchedIds.has(r.id)).map((r) => ({ voucherType: "CustomerReceipt", voucherId: r.id, voucherNo: r.receiptNo, date: r.receiptDate, amount: Number(r.amount) })),
      ...postedContras
        .filter((c) => !matchedIds.has(c.id))
        .map((c) => ({
          voucherType: "ContraVoucher",
          voucherId: c.id,
          voucherNo: c.voucherNo,
          date: c.voucherDate,
          amount: c.toBankAccountId === bankAccountId ? Number(c.amount) : -Number(c.amount),
        })),
    ];

    res.json({
      bankAccountId,
      asOfDate,
      bookBalance,
      statementBalance,
      difference: bookBalance - statementBalance,
      unreconciledStatementLines,
      outstandingVouchers,
    });
  })
);

// Transaction vouchers (Payment, Receipt, Journal, Credit/Debit Note,
// Contra) live in the Accounting module now - see
// src/modules/accounting/accounting.routes.ts, mounted at /api/accounting.
// Finance stays setup-and-reporting: Account Groups, Chart of Accounts,
// Bank Accounts, Posting Exceptions, and the trial-balance reports below.

// --- Posting Exceptions -----------------------------------------------------------
router.get(
  "/posting-exceptions",
  requirePermission("Finance.PostingException.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.postingException.findMany({ where, orderBy: { createdAt: "desc" } });
    res.json({ data: items });
  })
);

router.post(
  "/posting-exceptions/:id/resolve",
  requirePermission("Finance.PostingException.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.postingException.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    const record = await prisma.postingException.update({ where: { id: existing.id }, data: { status: "Resolved" } });
    res.json(record);
  })
);

// --- Trial Balance (simple derived report) -----------------------------------
router.get(
  "/reports/trial-balance",
  requirePermission("Finance.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid() });
    const { companyId } = schema.parse(req.query);

    const lines = await prisma.journalLine.findMany({
      where: { tenantId, journal: { companyId, status: "Posted" } },
      include: { account: true },
    });

    const byAccount = new Map<string, { code: string; name: string; debit: number; credit: number }>();
    for (const line of lines) {
      const key = line.accountId;
      const entry = byAccount.get(key) ?? { code: line.account.code, name: line.account.name, debit: 0, credit: 0 };
      entry.debit += Number(line.debit);
      entry.credit += Number(line.credit);
      byAccount.set(key, entry);
    }

    res.json({ data: [...byAccount.values()] });
  })
);

/**
 * Trial balance rolled up by account group, ordered by each group's
 * sortOrder, and split into the two financial statements a group's
 * natureType feeds: Asset/Liability/Equity -> Balance Sheet,
 * Revenue/Expense -> Profit and Loss. A lightweight step toward the full
 * P&L and Balance Sheet reports (BRD 5.9).
 */
router.get(
  "/reports/trial-balance-by-group",
  requirePermission("Finance.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid() });
    const { companyId } = schema.parse(req.query);

    const lines = await prisma.journalLine.findMany({
      where: { tenantId, journal: { companyId, status: "Posted" } },
      include: { account: { include: { group: true } } },
    });

    const byGroup = new Map<
      string,
      { groupId: string | null; groupCode: string; groupName: string; natureType: string; sortOrder: number; statement: string; debit: number; credit: number }
    >();

    for (const line of lines) {
      const group = line.account.group;
      const natureType = group?.natureType ?? line.account.accountType;
      const statement = natureType === "Revenue" || natureType === "Expense" ? "Profit and Loss" : "Balance Sheet";
      const key = group?.id ?? `ungrouped-${natureType}`;
      const entry = byGroup.get(key) ?? {
        groupId: group?.id ?? null,
        groupCode: group?.code ?? "UNGROUPED",
        groupName: group?.name ?? `Ungrouped (${natureType})`,
        natureType,
        sortOrder: group?.sortOrder ?? 999,
        statement,
        debit: 0,
        credit: 0,
      };
      entry.debit += Number(line.debit);
      entry.credit += Number(line.credit);
      byGroup.set(key, entry);
    }

    const data = [...byGroup.values()].sort((a, b) => a.sortOrder - b.sortOrder);
    res.json({ data });
  })
);

// --- P&L and Balance Sheet -----------------------------------------------------
// Built on the same account-group rollup as trial-balance-by-group above.
// Sectioning is driven by each group's natureType (always correct,
// independent of naming) with one extra split within Expense: a group
// literally coded DIRECT-EXPENSES is treated as Cost of Sales, everything
// else Expense-natured falls into Operating Expenses.
//
// The Balance Sheet is an interim (non-year-end-closed) statement: it adds
// a computed "Retained earnings (current period)" line to Equity, equal to
// cumulative net income from company inception through asOfDate, since
// P&L accounts don't carry a running balance of their own between formal
// year-end closes. That's what makes Assets == Liabilities + Equity below.
async function postedLines(tenantId: string, companyId: string, natureTypes: string[], fromDate?: Date, toDate?: Date) {
  const journalDate: Record<string, Date> = {};
  if (fromDate) journalDate.gte = fromDate;
  if (toDate) journalDate.lte = toDate;
  const lines = await prisma.journalLine.findMany({
    where: {
      tenantId,
      journal: { companyId, status: "Posted", ...(fromDate || toDate ? { journalDate } : {}) },
    },
    include: { account: { include: { group: true } } },
  });
  return lines.filter((l) => natureTypes.includes(l.account.group?.natureType ?? l.account.accountType));
}

function rollupByGroup(lines: Awaited<ReturnType<typeof postedLines>>) {
  const byGroup = new Map<string, { groupCode: string; groupName: string; natureType: string; sortOrder: number; debit: number; credit: number }>();
  for (const line of lines) {
    const group = line.account.group;
    const natureType = group?.natureType ?? line.account.accountType;
    const key = group?.code ?? `UNGROUPED-${natureType}`;
    const entry = byGroup.get(key) ?? { groupCode: key, groupName: group?.name ?? `Ungrouped (${natureType})`, natureType, sortOrder: group?.sortOrder ?? 999, debit: 0, credit: 0 };
    entry.debit += Number(line.debit);
    entry.credit += Number(line.credit);
    byGroup.set(key, entry);
  }
  return [...byGroup.values()].sort((a, b) => a.sortOrder - b.sortOrder);
}

async function computeNetIncome(tenantId: string, companyId: string, toDate: Date) {
  const lines = await postedLines(tenantId, companyId, ["Revenue", "Expense"], undefined, toDate);
  const groups = rollupByGroup(lines);
  let revenue = 0;
  let expense = 0;
  for (const g of groups) {
    if (g.natureType === "Revenue") revenue += g.credit - g.debit;
    else expense += g.debit - g.credit;
  }
  return revenue - expense;
}

router.get(
  "/reports/profit-and-loss",
  requirePermission("Finance.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid(), fromDate: z.coerce.date(), toDate: z.coerce.date() });
    const { companyId, fromDate, toDate } = schema.parse(req.query);

    const lines = await postedLines(tenantId, companyId, ["Revenue", "Expense"], fromDate, toDate);
    const groups = rollupByGroup(lines);

    const revenueLines = groups.filter((g) => g.natureType === "Revenue");
    const cogsLines = groups.filter((g) => g.natureType === "Expense" && g.groupCode === "DIRECT-EXPENSES");
    const opexLines = groups.filter((g) => g.natureType === "Expense" && g.groupCode !== "DIRECT-EXPENSES");

    const sum = (rows: typeof groups, side: "credit" | "debit") => rows.reduce((s, r) => s + (side === "credit" ? r.credit - r.debit : r.debit - r.credit), 0);
    const totalRevenue = sum(revenueLines, "credit");
    const totalCogs = sum(cogsLines, "debit");
    const grossProfit = totalRevenue - totalCogs;
    const totalOpex = sum(opexLines, "debit");
    const netProfit = grossProfit - totalOpex;

    res.json({
      companyId,
      fromDate,
      toDate,
      revenue: { lines: revenueLines.map((g) => ({ groupCode: g.groupCode, groupName: g.groupName, amount: g.credit - g.debit })), total: totalRevenue },
      costOfSales: { lines: cogsLines.map((g) => ({ groupCode: g.groupCode, groupName: g.groupName, amount: g.debit - g.credit })), total: totalCogs },
      grossProfit,
      operatingExpenses: { lines: opexLines.map((g) => ({ groupCode: g.groupCode, groupName: g.groupName, amount: g.debit - g.credit })), total: totalOpex },
      netProfit,
    });
  })
);

router.get(
  "/reports/balance-sheet",
  requirePermission("Finance.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid(), asOfDate: z.coerce.date().optional() });
    const { companyId, asOfDate = new Date() } = schema.parse(req.query);

    const lines = await postedLines(tenantId, companyId, ["Asset", "Liability", "Equity"], undefined, asOfDate);
    const groups = rollupByGroup(lines);

    const assetGroups = groups.filter((g) => g.natureType === "Asset");
    const liabilityGroups = groups.filter((g) => g.natureType === "Liability");
    const equityGroups = groups.filter((g) => g.natureType === "Equity");

    const netIncome = await computeNetIncome(tenantId, companyId, asOfDate);

    const totalAssets = assetGroups.reduce((s, g) => s + (g.debit - g.credit), 0);
    const totalLiabilities = liabilityGroups.reduce((s, g) => s + (g.credit - g.debit), 0);
    const totalEquity = equityGroups.reduce((s, g) => s + (g.credit - g.debit), 0) + netIncome;

    res.json({
      companyId,
      asOfDate,
      assets: { lines: assetGroups.map((g) => ({ groupCode: g.groupCode, groupName: g.groupName, amount: g.debit - g.credit })), total: totalAssets },
      liabilities: { lines: liabilityGroups.map((g) => ({ groupCode: g.groupCode, groupName: g.groupName, amount: g.credit - g.debit })), total: totalLiabilities },
      equity: {
        lines: [
          ...equityGroups.map((g) => ({ groupCode: g.groupCode, groupName: g.groupName, amount: g.credit - g.debit })),
          { groupCode: "RETAINED-EARNINGS", groupName: "Retained earnings (current period)", amount: netIncome },
        ],
        total: totalEquity,
      },
      totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
      balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
    });
  })
);

// --- Vendor / Customer Ledgers + Aging ---------------------------------------
// Statement-style view per vendor/customer: every posted invoice, payment
// or receipt, and credit/debit note in date order with a running balance,
// plus a 30/60/90 aging split of what's still outstanding.
//
// Aging is computed from *directly linked* applications only - a payment
// applied to a specific invoice via VendorPaymentInvoice/
// CustomerReceiptInvoice, or a debit/credit note issued against a specific
// invoice. Advance-mode payments and freestanding notes (no invoice link)
// still show up in the running-balance ledger below, but aren't netted
// against any one invoice's age - that requires manually allocating the
// advance to an invoice first, which is out of MVP scope (BRD doesn't spec
// an allocation screen).
const AGING_BUCKETS = ["Current", "1-30", "31-60", "61-90", "90+"] as const;

function ageInvoice(dueDate: Date, asOfDate: Date, outstanding: number, buckets: Record<string, number>) {
  const daysOverdue = Math.floor((asOfDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
  const bucket = daysOverdue <= 0 ? "Current" : daysOverdue <= 30 ? "1-30" : daysOverdue <= 60 ? "31-60" : daysOverdue <= 90 ? "61-90" : "90+";
  buckets[bucket] = (buckets[bucket] ?? 0) + outstanding;
}

router.get(
  "/reports/vendor-ledger",
  requirePermission("Finance.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ vendorId: z.string().uuid(), asOfDate: z.coerce.date().optional() });
    const { vendorId, asOfDate = new Date() } = schema.parse(req.query);

    const vendor = await prisma.vendor.findFirst({ where: { id: vendorId, tenantId }, include: { paymentTerms: true } });
    if (!vendor) throw ApiError.notFound();
    const netDays = vendor.paymentTerms?.days ?? 0;

    const [invoices, payments, debitNotes] = await Promise.all([
      prisma.purchaseInvoice.findMany({ where: { tenantId, vendorId, postingStatus: "Posted" } }),
      prisma.vendorPayment.findMany({
        where: { tenantId, vendorId, postingStatus: "Posted" },
        include: { invoices: true },
      }),
      prisma.vendorDebitNote.findMany({ where: { tenantId, vendorId, postingStatus: "Posted" } }),
    ]);

    type Entry = { date: Date; type: string; refNo: string; debit: number; credit: number; purchaseInvoiceId?: string | null };
    const entries: Entry[] = [];
    for (const inv of invoices) {
      entries.push({ date: inv.invoiceDate, type: "Invoice", refNo: inv.invoiceNo, debit: Number(inv.net), credit: 0 });
    }
    for (const pay of payments) {
      if (pay.mode === "Advance") {
        entries.push({ date: pay.paymentDate, type: "Payment (Advance)", refNo: pay.paymentNo, debit: 0, credit: Number(pay.amount) });
      } else {
        for (const app of pay.invoices) {
          entries.push({
            date: pay.paymentDate,
            type: "Payment",
            refNo: pay.paymentNo,
            debit: 0,
            credit: Number(app.appliedAmount),
            purchaseInvoiceId: app.purchaseInvoiceId,
          });
        }
      }
    }
    for (const dn of debitNotes) {
      entries.push({
        date: dn.createdAt,
        type: "Debit Note",
        refNo: dn.debitNoteNo,
        debit: 0,
        credit: Number(dn.amount),
        purchaseInvoiceId: dn.purchaseInvoiceId,
      });
    }

    entries.sort((a, b) => a.date.getTime() - b.date.getTime());
    let runningBalance = 0;
    const ledger = entries.map((e) => {
      runningBalance += e.debit - e.credit;
      return { ...e, balance: runningBalance };
    });

    const appliedByInvoice = new Map<string, number>();
    for (const e of entries) {
      if (e.purchaseInvoiceId) appliedByInvoice.set(e.purchaseInvoiceId, (appliedByInvoice.get(e.purchaseInvoiceId) ?? 0) + e.credit);
    }
    const aging: Record<string, number> = { Current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
    const outstandingInvoices: { invoiceNo: string; invoiceDate: Date; dueDate: Date; net: number; outstanding: number }[] = [];
    for (const inv of invoices) {
      const outstanding = Number(inv.net) - (appliedByInvoice.get(inv.id) ?? 0);
      if (outstanding > 0.01) {
        const dueDate = new Date(inv.invoiceDate.getTime() + netDays * 24 * 60 * 60 * 1000);
        ageInvoice(dueDate, asOfDate, outstanding, aging);
        outstandingInvoices.push({ invoiceNo: inv.invoiceNo, invoiceDate: inv.invoiceDate, dueDate, net: Number(inv.net), outstanding });
      }
    }

    res.json({
      vendor: { id: vendor.id, code: vendor.code, name: vendor.name },
      asOfDate,
      closingBalance: runningBalance,
      ledger,
      aging: { buckets: AGING_BUCKETS, amounts: aging, outstandingInvoices },
    });
  })
);

router.get(
  "/reports/customer-ledger",
  requirePermission("Finance.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ customerId: z.string().uuid(), asOfDate: z.coerce.date().optional() });
    const { customerId, asOfDate = new Date() } = schema.parse(req.query);

    const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId }, include: { paymentTerms: true } });
    if (!customer) throw ApiError.notFound();
    const netDays = customer.paymentTerms?.days ?? 0;

    const [invoices, receipts, creditNotes] = await Promise.all([
      prisma.salesInvoice.findMany({ where: { tenantId, customerId, postingStatus: "Posted" } }),
      prisma.customerReceipt.findMany({
        where: { tenantId, customerId, postingStatus: "Posted" },
        include: { invoices: true },
      }),
      prisma.customerCreditNote.findMany({ where: { tenantId, customerId, postingStatus: "Posted" } }),
    ]);

    type Entry = { date: Date; type: string; refNo: string; debit: number; credit: number; salesInvoiceId?: string | null };
    const entries: Entry[] = [];
    for (const inv of invoices) {
      entries.push({ date: inv.businessDate, type: "Invoice", refNo: inv.invoiceNo, debit: Number(inv.net), credit: 0 });
    }
    for (const rcpt of receipts) {
      if (rcpt.mode === "Advance") {
        entries.push({ date: rcpt.receiptDate, type: "Receipt (Advance)", refNo: rcpt.receiptNo, debit: 0, credit: Number(rcpt.amount) });
      } else {
        for (const app of rcpt.invoices) {
          entries.push({
            date: rcpt.receiptDate,
            type: "Receipt",
            refNo: rcpt.receiptNo,
            debit: 0,
            credit: Number(app.appliedAmount),
            salesInvoiceId: app.salesInvoiceId,
          });
        }
      }
    }
    for (const cn of creditNotes) {
      entries.push({
        date: cn.createdAt,
        type: "Credit Note",
        refNo: cn.creditNoteNo,
        debit: 0,
        credit: Number(cn.amount),
        salesInvoiceId: cn.salesInvoiceId,
      });
    }

    entries.sort((a, b) => a.date.getTime() - b.date.getTime());
    let runningBalance = 0;
    const ledger = entries.map((e) => {
      runningBalance += e.debit - e.credit;
      return { ...e, balance: runningBalance };
    });

    const appliedByInvoice = new Map<string, number>();
    for (const e of entries) {
      if (e.salesInvoiceId) appliedByInvoice.set(e.salesInvoiceId, (appliedByInvoice.get(e.salesInvoiceId) ?? 0) + e.credit);
    }
    const aging: Record<string, number> = { Current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
    const outstandingInvoices: { invoiceNo: string; invoiceDate: Date; dueDate: Date; net: number; outstanding: number }[] = [];
    for (const inv of invoices) {
      const outstanding = Number(inv.net) - (appliedByInvoice.get(inv.id) ?? 0);
      if (outstanding > 0.01) {
        const dueDate = inv.dueDate ?? new Date(inv.businessDate.getTime() + netDays * 24 * 60 * 60 * 1000);
        ageInvoice(dueDate, asOfDate, outstanding, aging);
        outstandingInvoices.push({ invoiceNo: inv.invoiceNo, invoiceDate: inv.businessDate, dueDate, net: Number(inv.net), outstanding });
      }
    }

    res.json({
      customer: { id: customer.id, code: customer.code, name: customer.name },
      asOfDate,
      closingBalance: runningBalance,
      ledger,
      aging: { buckets: AGING_BUCKETS, amounts: aging, outstandingInvoices },
    });
  })
);

export default router;
