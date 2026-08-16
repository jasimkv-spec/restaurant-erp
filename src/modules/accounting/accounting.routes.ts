import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePermission } from "../../middleware/rbac";
import { ApiError } from "../../utils/errors";
import { postJournal, recordPostingException } from "../../services/journalService";
import { resolveCoaByCode } from "../../services/coaLookup";
import { nextDocumentNumber } from "../../utils/documentNumber";

// Accounting: the day-to-day transaction vouchers - Payment, Receipt,
// Journal Voucher, Credit Note, Debit Note, Contra Voucher. Split out from
// Finance (Chart of Accounts / Account Groups / Bank Accounts / reports,
// which stays setup-and-reporting only) per the user's requested module
// separation.
//
// Note on Payment vouchers: the vendor-side "Payment" voucher
// (VendorPayment) still lives in the Procurement module
// (src/modules/procurement/procurement.routes.ts), because its posting
// logic is tightly coupled to Purchase Invoice matching (same pattern as
// GRN touching Inventory). It would still appear under an "Accounting"
// menu in the UI - the backend just owns that data next to the purchase
// documents it settles. Everything here is the AR/GL-native side: Receipt
// (customer), Journal Voucher, Credit Note, Debit Note, Contra Voucher.

const router = Router();

// --- Customer Receipts --------------------------------------------------------
// The AR mirror of Procurement's vendor-payments, per BRD 5.7/5.9 "customer
// receipts" / "customer advance".
router.post(
  "/customer-receipts",
  requirePermission("Accounting.CustomerReceipt.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      customerId: z.string().uuid(),
      amount: z.number().positive(),
      paymentMethodId: z.string().uuid(),
      bankAccountId: z.string().uuid().optional(),
      mode: z.enum(["Invoice", "Advance"]).default("Invoice"),
      invoices: z.array(z.object({ salesInvoiceId: z.string().uuid(), appliedAmount: z.number().positive() })).optional(),
      chequeNo: z.string().optional(),
      chequeDate: z.coerce.date().optional(),
    });
    const payload = schema.parse(req.body);

    if (payload.mode === "Invoice") {
      if (!payload.invoices || payload.invoices.length === 0) {
        throw ApiError.badRequest("Invoice-mode receipt needs at least one invoice to apply against");
      }
      const appliedTotal = payload.invoices.reduce((s, i) => s + i.appliedAmount, 0);
      if (Math.abs(appliedTotal - payload.amount) > 0.01) {
        throw ApiError.badRequest("Sum of applied amounts must equal the receipt amount");
      }
    } else if (payload.invoices && payload.invoices.length > 0) {
      throw ApiError.badRequest("Advance-mode receipt cannot be applied against invoices");
    }

    const record = await prisma.$transaction(async (tx) => {
      const receiptNo = await nextDocumentNumber(tx, { tenantId, companyId: payload.companyId, moduleCode: "CustomerReceipt", defaultPrefix: "RCPT" });
      const paymentMethod = await tx.paymentMethod.findUnique({ where: { id: payload.paymentMethodId } });
      if (paymentMethod?.type === "Cheque" && !payload.chequeNo) {
        throw ApiError.badRequest("chequeNo is required when receiving by a Cheque-type payment method");
      }
      return tx.customerReceipt.create({
        data: {
          tenantId,
          receiptNo,
          customerId: payload.customerId,
          amount: payload.amount,
          paymentMethodId: payload.paymentMethodId,
          bankAccountId: payload.bankAccountId,
          mode: payload.mode,
          chequeNo: payload.chequeNo,
          chequeDate: payload.chequeDate,
          chequeStatus: paymentMethod?.type === "Cheque" ? "Issued" : undefined,
          invoices: {
            create: (payload.invoices ?? []).map((i) => ({ tenantId, salesInvoiceId: i.salesInvoiceId, appliedAmount: i.appliedAmount })),
          },
        },
        include: { invoices: true },
      });
    });

    res.status(201).json(record);
  })
);

router.get(
  "/customer-receipts",
  requirePermission("Accounting.CustomerReceipt.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.customerId) where.customerId = req.query.customerId;
    const items = await prisma.customerReceipt.findMany({ where, include: { invoices: true }, orderBy: { receiptDate: "desc" } });
    res.json({ data: items });
  })
);

/**
 * Posts the receipt. Invoice mode: Dr Bank-Cash / Cr Accounts Receivable.
 * Advance mode: Dr Bank-Cash / Cr Customer Advance, per BRD 5.9 "customer
 * advance" - unearned until applied against a future invoice.
 */
router.post(
  "/customer-receipts/:id/post",
  requirePermission("Accounting.CustomerReceipt.Post"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid() });
    const { companyId } = schema.parse(req.body);

    const receipt = await prisma.customerReceipt.findFirst({
      where: { id: req.params.id, tenantId },
      include: { customer: true, bankAccount: true },
    });
    if (!receipt) throw ApiError.notFound();
    if (receipt.postingStatus === "Posted") throw ApiError.badRequest("Receipt already posted");

    await prisma.$transaction(async (tx) => {
      const creditAccount =
        receipt.mode === "Advance"
          ? await resolveCoaByCode(tx, tenantId, companyId, "CUSTOMER-ADVANCE")
          : (receipt.customer.receivableGlId && (await tx.chartOfAccount.findUnique({ where: { id: receipt.customer.receivableGlId } }))) ||
            (await resolveCoaByCode(tx, tenantId, companyId, "AR-CONTROL"));
      const creditAccountLabel = receipt.mode === "Advance" ? "CUSTOMER-ADVANCE" : "AR-CONTROL";
      const bankAccountId =
        receipt.bankAccount?.accountId ?? (await resolveCoaByCode(tx, tenantId, companyId, "CASH-CONTROL"))?.id;

      if (creditAccount && bankAccountId) {
        await postJournal(tx, {
          tenantId,
          companyId,
          sourceModule: "Accounting",
          sourceDocId: receipt.id,
          lines: [
            { accountId: bankAccountId, debit: Number(receipt.amount) },
            { accountId: creditAccount.id, credit: Number(receipt.amount) },
          ],
        });
      } else {
        await recordPostingException(tx, {
          tenantId,
          sourceModule: "Accounting",
          sourceDocId: receipt.id,
          exceptionType: "Missing GL",
          message: `${creditAccountLabel} or bank/cash account not configured for this company`,
        });
      }

      await tx.customerReceipt.update({ where: { id: receipt.id }, data: { postingStatus: "Posted" } });
    });

    const updated = await prisma.customerReceipt.findUnique({ where: { id: receipt.id } });
    res.json(updated);
  })
);

// --- Credit Notes / Debit Notes (manual) -------------------------------------
// The Sales Return and Goods Return flows already raise these automatically
// when a source invoice was already posted; these endpoints cover the
// freestanding case (e.g. a goodwill credit or a billing correction with no
// physical return behind it).
router.post(
  "/credit-notes",
  requirePermission("Accounting.CustomerCreditNote.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      customerId: z.string().uuid(),
      salesInvoiceId: z.string().uuid().optional(),
      amount: z.number().positive(),
    });
    const payload = schema.parse(req.body);
    const { companyId, ...noteData } = payload;

    const record = await prisma.$transaction(async (tx) => {
      const creditNoteNo = await nextDocumentNumber(tx, { tenantId, companyId, moduleCode: "CustomerCreditNote", defaultPrefix: "CN" });
      return tx.customerCreditNote.create({ data: { tenantId, creditNoteNo, ...noteData } });
    });

    res.status(201).json(record);
  })
);

router.get(
  "/credit-notes",
  requirePermission("Accounting.CustomerCreditNote.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.customerId) where.customerId = req.query.customerId;
    const items = await prisma.customerCreditNote.findMany({ where, orderBy: { createdAt: "desc" } });
    res.json({ data: items });
  })
);

/** Posts a manual credit note: Dr Revenue-Control / Cr Accounts Receivable. */
router.post(
  "/credit-notes/:id/post",
  requirePermission("Accounting.CustomerCreditNote.Post"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid(), contraAccountCode: z.string().default("REVENUE-CONTROL") });
    const { companyId, contraAccountCode } = schema.parse(req.body);

    const note = await prisma.customerCreditNote.findFirst({ where: { id: req.params.id, tenantId }, include: { customer: true } });
    if (!note) throw ApiError.notFound();
    if (note.postingStatus === "Posted") throw ApiError.badRequest("Credit note already posted");

    await prisma.$transaction(async (tx) => {
      const contraAccount = await resolveCoaByCode(tx, tenantId, companyId, contraAccountCode);
      const arControl =
        (note.customer.receivableGlId && (await tx.chartOfAccount.findUnique({ where: { id: note.customer.receivableGlId } }))) ||
        (await resolveCoaByCode(tx, tenantId, companyId, "AR-CONTROL"));

      if (contraAccount && arControl) {
        await postJournal(tx, {
          tenantId,
          companyId,
          sourceModule: "Accounting",
          sourceDocId: note.id,
          lines: [
            { accountId: contraAccount.id, debit: Number(note.amount) },
            { accountId: arControl.id, credit: Number(note.amount) },
          ],
        });
        await tx.customerCreditNote.update({ where: { id: note.id }, data: { postingStatus: "Posted" } });
      } else {
        await recordPostingException(tx, {
          tenantId,
          sourceModule: "Accounting",
          sourceDocId: note.id,
          exceptionType: "Missing GL",
          message: `${contraAccountCode} or AR-CONTROL account not configured for this company`,
        });
      }
    });

    const updated = await prisma.customerCreditNote.findUnique({ where: { id: note.id } });
    res.json(updated);
  })
);

router.post(
  "/debit-notes",
  requirePermission("Accounting.VendorDebitNote.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      vendorId: z.string().uuid(),
      purchaseInvoiceId: z.string().uuid().optional(),
      amount: z.number().positive(),
    });
    const payload = schema.parse(req.body);

    const record = await prisma.$transaction(async (tx) => {
      const debitNoteNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId: payload.companyId,
        moduleCode: "VendorDebitNote",
        defaultPrefix: "DN",
      });
      return tx.vendorDebitNote.create({
        data: { tenantId, debitNoteNo, vendorId: payload.vendorId, purchaseInvoiceId: payload.purchaseInvoiceId, amount: payload.amount },
      });
    });

    res.status(201).json(record);
  })
);

router.get(
  "/debit-notes",
  requirePermission("Accounting.VendorDebitNote.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.vendorId) where.vendorId = req.query.vendorId;
    const items = await prisma.vendorDebitNote.findMany({ where, orderBy: { createdAt: "desc" } });
    res.json({ data: items });
  })
);

/** Posts a manual debit note: Dr Accounts Payable / Cr <contra account>. */
router.post(
  "/debit-notes/:id/post",
  requirePermission("Accounting.VendorDebitNote.Post"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid(), contraAccountCode: z.string().default("COGS-CONTROL") });
    const { companyId, contraAccountCode } = schema.parse(req.body);

    const note = await prisma.vendorDebitNote.findFirst({ where: { id: req.params.id, tenantId }, include: { vendor: true } });
    if (!note) throw ApiError.notFound();
    if (note.postingStatus === "Posted") throw ApiError.badRequest("Debit note already posted");

    await prisma.$transaction(async (tx) => {
      const contraAccount = await resolveCoaByCode(tx, tenantId, companyId, contraAccountCode);
      const apControl =
        (note.vendor.payableGlId && (await tx.chartOfAccount.findUnique({ where: { id: note.vendor.payableGlId } }))) ||
        (await resolveCoaByCode(tx, tenantId, companyId, "AP-CONTROL"));

      if (contraAccount && apControl) {
        await postJournal(tx, {
          tenantId,
          companyId,
          sourceModule: "Accounting",
          sourceDocId: note.id,
          lines: [
            { accountId: apControl.id, debit: Number(note.amount) },
            { accountId: contraAccount.id, credit: Number(note.amount) },
          ],
        });
        await tx.vendorDebitNote.update({ where: { id: note.id }, data: { postingStatus: "Posted" } });
      } else {
        await recordPostingException(tx, {
          tenantId,
          sourceModule: "Accounting",
          sourceDocId: note.id,
          exceptionType: "Missing GL",
          message: `${contraAccountCode} or AP-CONTROL account not configured for this company`,
        });
      }
    });

    const updated = await prisma.vendorDebitNote.findUnique({ where: { id: note.id } });
    res.json(updated);
  })
);

// --- Contra Voucher -----------------------------------------------------------
// A transfer between two of the company's own bank/cash accounts, per BRD
// 5.9 "banking, contra, cheque register".
router.post(
  "/contra-vouchers",
  requirePermission("Accounting.ContraVoucher.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      fromBankAccountId: z.string().uuid(),
      toBankAccountId: z.string().uuid(),
      amount: z.number().positive(),
      narration: z.string().optional(),
    });
    const payload = schema.parse(req.body);
    if (payload.fromBankAccountId === payload.toBankAccountId) {
      throw ApiError.badRequest("fromBankAccountId and toBankAccountId must be different accounts");
    }

    const record = await prisma.$transaction(async (tx) => {
      const voucherNo = await nextDocumentNumber(tx, { tenantId, companyId: payload.companyId, moduleCode: "ContraVoucher", defaultPrefix: "CV" });
      return tx.contraVoucher.create({ data: { tenantId, voucherNo, ...payload } });
    });

    res.status(201).json(record);
  })
);

router.get(
  "/contra-vouchers",
  requirePermission("Accounting.ContraVoucher.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const items = await prisma.contraVoucher.findMany({ where: { tenantId }, orderBy: { voucherDate: "desc" } });
    res.json({ data: items });
  })
);

/** Posts Dr toBankAccount / Cr fromBankAccount, each at its own GL account. */
router.post(
  "/contra-vouchers/:id/post",
  requirePermission("Accounting.ContraVoucher.Post"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const voucher = await prisma.contraVoucher.findFirst({
      where: { id: req.params.id, tenantId },
      include: { fromBankAccount: true, toBankAccount: true },
    });
    if (!voucher) throw ApiError.notFound();
    if (voucher.status !== "Draft") throw ApiError.badRequest(`Contra voucher already ${voucher.status}`);

    await prisma.$transaction(async (tx) => {
      await postJournal(tx, {
        tenantId,
        companyId: voucher.companyId,
        sourceModule: "Accounting",
        sourceDocId: voucher.id,
        lines: [
          { accountId: voucher.toBankAccount.accountId, debit: Number(voucher.amount) },
          { accountId: voucher.fromBankAccount.accountId, credit: Number(voucher.amount) },
        ],
      });
      await tx.contraVoucher.update({ where: { id: voucher.id }, data: { status: "Posted" } });
    });

    const updated = await prisma.contraVoucher.findUnique({ where: { id: voucher.id } });
    res.json(updated);
  })
);

// --- Journal Entries (manual vouchers) --------------------------------------
router.get(
  "/journal-entries",
  requirePermission("Accounting.JournalEntry.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.companyId) where.companyId = req.query.companyId;
    if (req.query.sourceModule) where.sourceModule = req.query.sourceModule;
    const items = await prisma.journalEntry.findMany({
      where,
      include: { lines: true },
      orderBy: { journalDate: "desc" },
    });
    res.json({ data: items });
  })
);

router.get(
  "/journal-entries/:id",
  requirePermission("Accounting.JournalEntry.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.journalEntry.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: { include: { account: true } } },
    });
    if (!record) throw ApiError.notFound();
    res.json(record);
  })
);

/**
 * POST /accounting/journal-entries
 * Manual journal voucher (BRD 5.9: "Posting engine ... journal preview, GL
 * posting"). Validates total debit == total credit before posting -
 * unbalanced requests are rejected outright rather than queued, since a
 * manual entry has no automated source document to correct.
 */
router.post(
  "/journal-entries",
  requirePermission("Accounting.JournalEntry.Post"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      journalDate: z.coerce.date().optional(),
      lines: z
        .array(
          z.object({
            accountId: z.string().uuid(),
            debit: z.number().nonnegative().default(0),
            credit: z.number().nonnegative().default(0),
            branchId: z.string().uuid().optional(),
            costCentreId: z.string().uuid().optional(),
            profitCentreId: z.string().uuid().optional(),
          })
        )
        .min(2),
    });
    const payload = schema.parse(req.body);

    const journal = await prisma.$transaction((tx) =>
      postJournal(tx, {
        tenantId,
        companyId: payload.companyId,
        sourceModule: "Manual",
        journalDate: payload.journalDate,
        postedBy: req.user?.userId,
        lines: payload.lines,
      })
    );

    res.status(201).json(journal);
  })
);

export default router;
