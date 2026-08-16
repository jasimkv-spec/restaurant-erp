import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { crudRouter } from "../../utils/crudFactory";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePermission } from "../../middleware/rbac";
import { ApiError } from "../../utils/errors";
import { postJournal, recordPostingException } from "../../services/journalService";
import { resolveCoaByCode } from "../../services/coaLookup";
import { nextDocumentNumber } from "../../utils/documentNumber";
import { postStockMovement } from "../../services/stockService";

const router = Router();

// --- Customers -----------------------------------------------------------
router.use(
  "/customers",
  crudRouter(prisma.customer, {
    permissionKey: "Sales.Customer",
    createSchema: z.object({
      code: z.string().min(1).max(50),
      name: z.string().min(1),
      customerType: z.enum(["Walk-in", "Corporate", "Aggregator", "Staff"]).default("Walk-in"),
      contactPerson: z.string().optional(),
      phone: z.string().optional(),
      whatsapp: z.string().optional(),
      email: z.string().email().optional(),
      address: z.string().optional(),
      countryId: z.string().uuid().optional(),
      cityId: z.string().uuid().optional(),
      areaId: z.string().uuid().optional(),
      taxRegistrationNumber: z.string().optional(),
      paymentTermsId: z.string().uuid().optional(),
      dateOfBirth: z.coerce.date().optional(),
      receivableGlId: z.string().uuid().optional(),
      creditLimit: z.number().nonnegative().optional(),
      notes: z.string().optional(),
    }),
    include: { country: true, city: true, area: true, paymentTerms: true },
  })
);

// --- Sales Quotes (wholesale/B2B) --------------------------------------------
// Not detailed at screen-spec level in the original blueprint - built at the
// user's request for the wholesale flow: Quote -> convert to a draft
// Wholesale invoice -> deliver via a Delivery Order -> post the invoice.
const quoteLineSchema = z.object({
  itemId: z.string().uuid(),
  qty: z.number().positive(),
  uomId: z.string().uuid().optional(),
  unitPrice: z.number().nonnegative(),
  taxId: z.string().uuid().optional(),
});

router.post(
  "/sales-quotes",
  requirePermission("Sales.SalesQuote.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      customerId: z.string().uuid(),
      branchId: z.string().uuid(),
      validUntil: z.coerce.date().optional(),
      notes: z.string().optional(),
      lines: z.array(quoteLineSchema).min(1),
    });
    const payload = schema.parse(req.body);

    const record = await prisma.$transaction(async (tx) => {
      const quoteNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId: (await tx.branch.findUniqueOrThrow({ where: { id: payload.branchId } })).companyId,
        moduleCode: "SalesQuote",
        defaultPrefix: "QTN",
      });
      return tx.salesQuote.create({
        data: {
          tenantId,
          quoteNo,
          customerId: payload.customerId,
          branchId: payload.branchId,
          validUntil: payload.validUntil,
          notes: payload.notes,
          lines: { create: payload.lines.map((l) => ({ ...l, tenantId })) },
        },
        include: { lines: true },
      });
    });

    res.status(201).json(record);
  })
);

router.get(
  "/sales-quotes",
  requirePermission("Sales.SalesQuote.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.customerId) where.customerId = req.query.customerId;
    const items = await prisma.salesQuote.findMany({ where, include: { lines: true }, orderBy: { createdAt: "desc" } });
    res.json({ data: items });
  })
);

router.get(
  "/sales-quotes/:id",
  requirePermission("Sales.SalesQuote.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.salesQuote.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: { include: { item: true, tax: true } }, customer: true },
    });
    if (!record) throw ApiError.notFound();
    res.json(record);
  })
);

router.post(
  "/sales-quotes/:id/send",
  requirePermission("Sales.SalesQuote.Submit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.salesQuote.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    if (existing.status !== "Draft") throw ApiError.badRequest(`Cannot send quote in status ${existing.status}`);
    const record = await prisma.salesQuote.update({ where: { id: existing.id }, data: { status: "Sent" } });
    res.json(record);
  })
);

/** Converts an accepted quote into a draft Wholesale sales invoice - due
 * date is set from the customer's payment terms. Not yet posted; a
 * DeliveryOrder ships the goods first. */
router.post(
  "/sales-quotes/:id/convert-to-invoice",
  requirePermission("Sales.SalesQuote.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const quote = await prisma.salesQuote.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: true, customer: { include: { paymentTerms: true } } },
    });
    if (!quote) throw ApiError.notFound();
    if (quote.status === "Converted") throw ApiError.badRequest("Quote already converted");

    const gross = quote.lines.reduce((sum, l) => sum + Number(l.qty) * Number(l.unitPrice), 0);
    const dueDate = quote.customer.paymentTerms
      ? new Date(Date.now() + quote.customer.paymentTerms.days * 24 * 60 * 60 * 1000)
      : undefined;

    const record = await prisma.$transaction(async (tx) => {
      const branch = await tx.branch.findUniqueOrThrow({ where: { id: quote.branchId } });
      const invoiceNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId: branch.companyId,
        moduleCode: "SalesInvoice",
        defaultPrefix: "INV",
      });
      const invoice = await tx.salesInvoice.create({
        data: {
          tenantId,
          branchId: quote.branchId,
          customerId: quote.customerId,
          sourceQuoteId: quote.id,
          salesType: "Wholesale",
          businessDate: new Date(),
          invoiceNo,
          gross,
          net: gross,
          dueDate,
          lines: {
            create: quote.lines.map((l) => ({
              tenantId,
              itemId: l.itemId,
              qty: l.qty,
              unitPrice: l.unitPrice,
              taxId: l.taxId,
            })),
          },
        },
        include: { lines: true },
      });
      await tx.salesQuote.update({ where: { id: quote.id }, data: { status: "Converted" } });
      return invoice;
    });

    res.status(201).json(record);
  })
);

// --- Sales Channels -----------------------------------------------------------
router.use(
  "/sales-channels",
  crudRouter(prisma.salesChannel, {
    permissionKey: "Sales.SalesChannel",
    createSchema: z.object({
      code: z.string().min(1).max(30),
      name: z.string().min(1),
      defaultCustomerId: z.string().uuid().optional(),
      revenueGlId: z.string().uuid().optional(),
    }),
  })
);

// --- POS Connectors -----------------------------------------------------------
router.use(
  "/pos-connectors",
  crudRouter(prisma.posConnector, {
    permissionKey: "Sales.PosConnector",
    createSchema: z.object({
      branchId: z.string().uuid(),
      provider: z.enum(["Manual Excel", "API Ready", "Foodics", "Oracle MICROS", "LS Retail", "Square", "Custom POS"]),
      connectionType: z.enum(["File", "API", "Manual"]).default("File"),
      externalStoreCode: z.string().optional(),
    }),
  })
);

// --- POS Item Mapping -----------------------------------------------------------
router.use(
  "/pos-item-mappings",
  crudRouter(prisma.posItemMapping, {
    permissionKey: "Sales.PosItemMapping",
    createSchema: z.object({
      branchId: z.string().uuid(),
      posItemCode: z.string().min(1).max(100),
      itemId: z.string().uuid(),
      recipeId: z.string().uuid().optional(),
      taxId: z.string().uuid().optional(),
      activeFrom: z.coerce.date().optional(),
    }),
    statusField: "posItemCode",
  })
);

// --- Sales Import ------------------------------------------------------------
const importLineSchema = z.object({
  itemId: z.string().uuid().optional(),
  posItemCode: z.string().optional(),
  qty: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  taxId: z.string().uuid().optional(),
});

const importInvoiceSchema = z.object({
  invoiceNo: z.string().min(1),
  customerId: z.string().uuid().optional(),
  salesChannelId: z.string().uuid().optional(),
  gross: z.number().nonnegative(),
  discount: z.number().nonnegative().default(0),
  tax: z.number().nonnegative().default(0),
  lines: z.array(importLineSchema).min(1),
  payments: z.array(z.object({ paymentMethodId: z.string().uuid(), amount: z.number().positive(), referenceNo: z.string().optional() })).min(1),
});

/**
 * POST /sales/import
 * Imports a batch of POS invoices for a branch/business date, per BRD 5.7:
 * "Sales import using header, line, payment ... data" with duplicate and
 * mapping validation routed to an exception queue rather than failing the
 * whole batch (BRD 10.1).
 */
router.post(
  "/sales-import",
  requirePermission("Sales.SalesImport.Import"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      branchId: z.string().uuid(),
      connectorId: z.string().uuid().optional(),
      businessDate: z.coerce.date(),
      invoices: z.array(importInvoiceSchema).min(1),
    });
    const payload = schema.parse(req.body);

    const batch = await prisma.salesImportBatch.create({
      data: {
        tenantId,
        branchId: payload.branchId,
        connectorId: payload.connectorId,
        businessDate: payload.businessDate,
      },
    });

    const created: unknown[] = [];
    const exceptions: { invoiceNo: string; reason: string }[] = [];

    for (const inv of payload.invoices) {
      const duplicate = await prisma.salesInvoice.findFirst({
        where: { tenantId, branchId: payload.branchId, invoiceNo: inv.invoiceNo, businessDate: payload.businessDate },
      });
      if (duplicate) {
        exceptions.push({ invoiceNo: inv.invoiceNo, reason: "Duplicate invoice for this branch/business date" });
        continue;
      }

      // Resolve posItemCode -> itemId where itemId wasn't supplied directly.
      const resolvedLines: any[] = [];
      let lineException: string | null = null;
      for (const line of inv.lines) {
        let itemId = line.itemId;
        let recipeVersionId: string | undefined;
        if (!itemId && line.posItemCode) {
          const mapping = await prisma.posItemMapping.findFirst({
            where: { tenantId, branchId: payload.branchId, posItemCode: line.posItemCode },
            orderBy: { activeFrom: "desc" },
          });
          if (!mapping) {
            lineException = `Missing POS item mapping for code ${line.posItemCode}`;
            break;
          }
          itemId = mapping.itemId;
          if (mapping.recipeId) {
            const approvedVersion = await prisma.recipeVersion.findFirst({
              where: { tenantId, recipeId: mapping.recipeId, status: "Approved" },
            });
            recipeVersionId = approvedVersion?.id;
          }
        }
        if (!itemId) {
          lineException = "Sales line has neither itemId nor a resolvable posItemCode";
          break;
        }
        resolvedLines.push({ ...line, itemId, recipeVersionId, tenantId });
      }

      if (lineException) {
        exceptions.push({ invoiceNo: inv.invoiceNo, reason: lineException });
        continue;
      }

      const net = inv.gross - inv.discount + inv.tax;
      const invoice = await prisma.salesInvoice.create({
        data: {
          tenantId,
          branchId: payload.branchId,
          customerId: inv.customerId,
          salesChannelId: inv.salesChannelId,
          importBatchId: batch.id,
          businessDate: payload.businessDate,
          invoiceNo: inv.invoiceNo,
          gross: inv.gross,
          discount: inv.discount,
          tax: inv.tax,
          net,
          lines: { create: resolvedLines },
          payments: { create: inv.payments.map((p) => ({ ...p, tenantId })) },
        },
        include: { lines: true, payments: true },
      });
      created.push(invoice);
    }

    await prisma.salesImportBatch.update({
      where: { id: batch.id },
      data: { status: exceptions.length > 0 ? "Exception" : "Validated" },
    });

    res.status(201).json({ batch, created, exceptions });
  })
);

router.get(
  "/sales-import-batches",
  requirePermission("Sales.SalesImport.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const items = await prisma.salesImportBatch.findMany({
      where: { tenantId },
      include: { invoices: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: items });
  })
);

// --- Sales Invoices -----------------------------------------------------------
router.get(
  "/sales-invoices",
  requirePermission("Sales.SalesInvoice.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.branchId) where.branchId = req.query.branchId;
    if (req.query.postingStatus) where.postingStatus = req.query.postingStatus;
    const items = await prisma.salesInvoice.findMany({ where, include: { lines: true, payments: true }, orderBy: { businessDate: "desc" } });
    res.json({ data: items });
  })
);

/** Attaches a Modifier-type recipe to a sold line (e.g. "extra cheese"),
 * per BRD 5.6 "modifiers basic" - exploded alongside the base recipe when
 * consumption is generated for the line's business date. */
router.post(
  "/sales-invoice-lines/:id/modifiers",
  requirePermission("Sales.SalesInvoice.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const line = await prisma.salesInvoiceLine.findFirst({ where: { id: req.params.id, tenantId } });
    if (!line) throw ApiError.notFound();

    const schema = z.object({ modifierRecipeVersionId: z.string().uuid(), qty: z.number().positive().default(1) });
    const payload = schema.parse(req.body);

    const record = await prisma.salesInvoiceLineModifier.create({
      data: { tenantId, salesInvoiceLineId: line.id, ...payload },
    });
    res.status(201).json(record);
  })
);

router.get(
  "/sales-invoices/:id",
  requirePermission("Sales.SalesInvoice.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.salesInvoice.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: { include: { item: true, tax: true } }, payments: { include: { paymentMethod: true } } },
    });
    if (!record) throw ApiError.notFound();
    res.json(record);
  })
);

/**
 * Directly creates a draft Wholesale sales invoice for a B2B customer,
 * without going through a quote or POS import. Due date is set from the
 * customer's payment terms.
 */
router.post(
  "/sales-invoices/wholesale",
  requirePermission("Sales.SalesInvoice.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      branchId: z.string().uuid(),
      customerId: z.string().uuid(),
      sourceQuoteId: z.string().uuid().optional(),
      lines: z.array(quoteLineSchema).min(1),
    });
    const payload = schema.parse(req.body);

    const customer = await prisma.customer.findFirst({
      where: { id: payload.customerId, tenantId },
      include: { paymentTerms: true },
    });
    if (!customer) throw ApiError.badRequest("customerId not found");

    const gross = payload.lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
    const dueDate = customer.paymentTerms ? new Date(Date.now() + customer.paymentTerms.days * 24 * 60 * 60 * 1000) : undefined;

    const record = await prisma.$transaction(async (tx) => {
      const branch = await tx.branch.findUniqueOrThrow({ where: { id: payload.branchId } });
      const invoiceNo = await nextDocumentNumber(tx, {
        tenantId,
        companyId: branch.companyId,
        moduleCode: "SalesInvoice",
        defaultPrefix: "INV",
      });
      return tx.salesInvoice.create({
        data: {
          tenantId,
          branchId: payload.branchId,
          customerId: payload.customerId,
          sourceQuoteId: payload.sourceQuoteId,
          salesType: "Wholesale",
          businessDate: new Date(),
          invoiceNo,
          gross,
          net: gross,
          dueDate,
          lines: {
            create: payload.lines.map((l) => ({ tenantId, itemId: l.itemId, qty: l.qty, unitPrice: l.unitPrice, taxId: l.taxId })),
          },
        },
        include: { lines: true },
      });
    });

    res.status(201).json(record);
  })
);

/**
 * Posts revenue/tax for a sales invoice, per BRD 5.7 / key workflow "Sales
 * to Settlement". POS invoices: Dr Sales Clearing / Cr Revenue / Cr Tax
 * Output (settled by SalesPayment records already captured). Wholesale
 * invoices are on credit instead: Dr Accounts Receivable / Cr Revenue /
 * Cr Tax Output, using the customer's own receivable account if set.
 */
router.post(
  "/sales-invoices/:id/post",
  requirePermission("Sales.SalesInvoice.Post"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid() });
    const { companyId } = schema.parse(req.body);

    const invoice = await prisma.salesInvoice.findFirst({
      where: { id: req.params.id, tenantId },
      include: { payments: true, salesChannel: true, customer: true },
    });
    if (!invoice) throw ApiError.notFound();
    if (invoice.postingStatus === "Posted") throw ApiError.badRequest("Invoice already posted");

    await prisma.$transaction(async (tx) => {
      const revenueAccount =
        (invoice.salesChannel?.revenueGlId &&
          (await tx.chartOfAccount.findUnique({ where: { id: invoice.salesChannel.revenueGlId } }))) ||
        (await resolveCoaByCode(tx, tenantId, companyId, "REVENUE-CONTROL"));
      const taxOutput = await resolveCoaByCode(tx, tenantId, companyId, "TAX-OUTPUT");

      const debitAccount =
        invoice.salesType === "Wholesale"
          ? (invoice.customer?.receivableGlId &&
              (await tx.chartOfAccount.findUnique({ where: { id: invoice.customer.receivableGlId } }))) ||
            (await resolveCoaByCode(tx, tenantId, companyId, "AR-CONTROL"))
          : await resolveCoaByCode(tx, tenantId, companyId, "SALES-CLEARING");
      const debitAccountLabel = invoice.salesType === "Wholesale" ? "AR-CONTROL" : "SALES-CLEARING";

      const revenueAmount = Number(invoice.gross) - Number(invoice.discount);
      const taxAmount = Number(invoice.tax);

      if (revenueAccount && debitAccount) {
        const lines = [{ accountId: debitAccount.id, debit: Number(invoice.net) }, { accountId: revenueAccount.id, credit: revenueAmount }];
        if (taxAmount > 0 && taxOutput) {
          lines.push({ accountId: taxOutput.id, credit: taxAmount });
        } else if (taxAmount > 0) {
          lines[1] = { accountId: revenueAccount.id, credit: revenueAmount + taxAmount }; // fallback if no tax account configured
        }
        await postJournal(tx, {
          tenantId,
          companyId,
          sourceModule: "Sales",
          sourceDocId: invoice.id,
          lines,
        });
      } else {
        await recordPostingException(tx, {
          tenantId,
          sourceModule: "Sales",
          sourceDocId: invoice.id,
          exceptionType: "Missing GL",
          message: `REVENUE-CONTROL or ${debitAccountLabel} account not configured for this company`,
        });
      }

      await tx.salesInvoice.update({ where: { id: invoice.id }, data: { postingStatus: "Posted" } });
    });

    const updated = await prisma.salesInvoice.findUnique({ where: { id: invoice.id } });
    res.json(updated);
  })
);

// --- Delivery Order (DO) ------------------------------------------------------
// Ships goods to the customer, ahead of or alongside a Wholesale invoice.
const doLineSchema = z.object({
  itemId: z.string().uuid(),
  qty: z.number().positive(),
  batchNo: z.string().optional(),
});

router.post(
  "/delivery-orders",
  requirePermission("Sales.DeliveryOrder.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      salesInvoiceId: z.string().uuid().optional(),
      customerId: z.string().uuid(),
      branchId: z.string().uuid(),
      warehouseId: z.string().uuid(),
      notes: z.string().optional(),
      lines: z.array(doLineSchema).min(1),
    });
    const payload = schema.parse(req.body);

    const record = await prisma.$transaction(async (tx) => {
      const doNo = await nextDocumentNumber(tx, { tenantId, companyId: payload.companyId, moduleCode: "DeliveryOrder", defaultPrefix: "DO" });
      return tx.deliveryOrder.create({
        data: {
          tenantId,
          doNo,
          salesInvoiceId: payload.salesInvoiceId,
          customerId: payload.customerId,
          branchId: payload.branchId,
          warehouseId: payload.warehouseId,
          notes: payload.notes,
          lines: { create: payload.lines.map((l) => ({ ...l, tenantId })) },
        },
        include: { lines: true },
      });
    });

    res.status(201).json(record);
  })
);

router.get(
  "/delivery-orders",
  requirePermission("Sales.DeliveryOrder.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.customerId) where.customerId = req.query.customerId;
    const items = await prisma.deliveryOrder.findMany({ where, include: { lines: true }, orderBy: { createdAt: "desc" } });
    res.json({ data: items });
  })
);

router.get(
  "/delivery-orders/:id",
  requirePermission("Sales.DeliveryOrder.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.deliveryOrder.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: { include: { item: true } }, customer: true },
    });
    if (!record) throw ApiError.notFound();
    res.json(record);
  })
);

/** Ships the goods: posts a stock decrease at the item's average cost and
 * books Dr COGS / Cr Inventory Asset, the sales-side mirror of a GRN. */
router.post(
  "/delivery-orders/:id/deliver",
  requirePermission("Sales.DeliveryOrder.Deliver"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid() });
    const { companyId } = schema.parse(req.body);

    const doRecord = await prisma.deliveryOrder.findFirst({ where: { id: req.params.id, tenantId }, include: { lines: true } });
    if (!doRecord) throw ApiError.notFound();
    if (doRecord.status !== "Draft") throw ApiError.badRequest(`Delivery order already ${doRecord.status}`);

    await prisma.$transaction(async (tx) => {
      let totalCost = 0;
      for (const line of doRecord.lines) {
        const result = await postStockMovement(tx, {
          tenantId,
          itemId: line.itemId,
          warehouseId: doRecord.warehouseId,
          batchNo: line.batchNo,
          qtyOut: Number(line.qty),
          sourceModule: "Sales",
          sourceDocType: "DeliveryOrder",
          sourceDocId: doRecord.id,
        });
        await tx.deliveryOrderLine.update({ where: { id: line.id }, data: { unitCost: result.unitCostApplied } });
        totalCost += Number(line.qty) * result.unitCostApplied;
      }

      await tx.deliveryOrder.update({ where: { id: doRecord.id }, data: { status: "Delivered" } });

      if (totalCost > 0) {
        const cogsAccount = await resolveCoaByCode(tx, tenantId, companyId, "COGS-CONTROL");
        const inventoryControl = await resolveCoaByCode(tx, tenantId, companyId, "INVENTORY-CONTROL");
        if (cogsAccount && inventoryControl) {
          await postJournal(tx, {
            tenantId,
            companyId,
            sourceModule: "Sales",
            sourceDocId: doRecord.id,
            lines: [
              { accountId: cogsAccount.id, debit: totalCost },
              { accountId: inventoryControl.id, credit: totalCost },
            ],
          });
        } else {
          await recordPostingException(tx, {
            tenantId,
            sourceModule: "Sales",
            sourceDocId: doRecord.id,
            exceptionType: "Missing GL",
            message: "COGS-CONTROL or INVENTORY-CONTROL account not configured for this company",
          });
        }
      }
    });

    const updated = await prisma.deliveryOrder.findUnique({ where: { id: doRecord.id }, include: { lines: true } });
    res.json(updated);
  })
);

// --- Sales Return --------------------------------------------------------------
// Customer sends goods back. Mirrors the vendor Goods Return: restocks at
// the original cost, and raises a credit note against the customer if the
// source invoice was already posted.
const salesReturnLineSchema = z.object({
  doLineId: z.string().uuid().optional(),
  itemId: z.string().uuid(),
  batchNo: z.string().optional(),
  returnQty: z.number().positive(),
  unitCost: z.number().nonnegative().optional(),
  unitPrice: z.number().nonnegative().optional(),
});

router.post(
  "/sales-returns",
  requirePermission("Sales.SalesReturn.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      companyId: z.string().uuid(),
      salesInvoiceId: z.string().uuid().optional(),
      doId: z.string().uuid().optional(),
      customerId: z.string().uuid(),
      branchId: z.string().uuid(),
      warehouseId: z.string().uuid(),
      reason: z.string().optional(),
      lines: z.array(salesReturnLineSchema).min(1),
    });
    const payload = schema.parse(req.body);

    // Return qty (this request + anything already returned) cannot exceed
    // what was actually delivered on the referenced DO line.
    for (const line of payload.lines) {
      if (!line.doLineId) continue;
      const doLine = await prisma.deliveryOrderLine.findFirst({ where: { id: line.doLineId, tenantId } });
      if (!doLine) throw ApiError.badRequest(`Delivery order line ${line.doLineId} not found`);
      const alreadyReturned = await prisma.salesReturnLine.aggregate({
        where: { tenantId, doLineId: line.doLineId, salesReturn: { status: { not: "Cancelled" } } },
        _sum: { returnQty: true },
      });
      const returnedSoFar = Number(alreadyReturned._sum.returnQty ?? 0);
      if (returnedSoFar + line.returnQty > Number(doLine.qty) + 1e-9) {
        throw ApiError.badRequest(`Return qty exceeds delivered qty (delivered ${doLine.qty}, already returned ${returnedSoFar})`);
      }
    }

    // Fill in unitPrice from the source invoice line where not supplied, so
    // the eventual credit note reflects what the customer actually paid.
    const linesResolved: Array<z.infer<typeof salesReturnLineSchema> & { unitPrice: number | undefined }> = [];
    for (const l of payload.lines) {
      let unitPrice = l.unitPrice;
      if (unitPrice === undefined && payload.salesInvoiceId) {
        const invLine = await prisma.salesInvoiceLine.findFirst({
          where: { tenantId, salesInvoiceId: payload.salesInvoiceId, itemId: l.itemId },
        });
        unitPrice = invLine ? Number(invLine.unitPrice) : undefined;
      }
      linesResolved.push({ ...l, unitPrice });
    }

    const record = await prisma.$transaction(async (tx) => {
      const returnNo = await nextDocumentNumber(tx, { tenantId, companyId: payload.companyId, moduleCode: "SalesReturn", defaultPrefix: "SRT" });
      return tx.salesReturn.create({
        data: {
          tenantId,
          returnNo,
          salesInvoiceId: payload.salesInvoiceId,
          doId: payload.doId,
          customerId: payload.customerId,
          branchId: payload.branchId,
          warehouseId: payload.warehouseId,
          reason: payload.reason,
          lines: { create: linesResolved.map((l) => ({ ...l, tenantId })) },
        },
        include: { lines: true },
      });
    });

    res.status(201).json(record);
  })
);

router.get(
  "/sales-returns",
  requirePermission("Sales.SalesReturn.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.customerId) where.customerId = req.query.customerId;
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.salesReturn.findMany({ where, include: { lines: true }, orderBy: { createdAt: "desc" } });
    res.json({ data: items });
  })
);

router.get(
  "/sales-returns/:id",
  requirePermission("Sales.SalesReturn.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.salesReturn.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: { include: { item: true } }, customer: true },
    });
    if (!record) throw ApiError.notFound();
    res.json(record);
  })
);

/**
 * Posts the sales return: restocks each line (qtyIn at its captured unit
 * cost) then, if the source invoice is already posted, raises and posts a
 * customer credit note at the returned lines' selling price - Dr Revenue /
 * Dr Tax Output (proportionally) / Cr Accounts Receivable.
 */
router.post(
  "/sales-returns/:id/post",
  requirePermission("Sales.SalesReturn.Post"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ companyId: z.string().uuid() });
    const { companyId } = schema.parse(req.body);

    const salesReturn = await prisma.salesReturn.findFirst({ where: { id: req.params.id, tenantId } });
    if (!salesReturn) throw ApiError.notFound();
    if (salesReturn.status !== "Draft") throw ApiError.badRequest(`Sales return already ${salesReturn.status}`);

    const linesWithDetail = await prisma.salesReturnLine.findMany({
      where: { returnId: salesReturn.id },
      include: { item: true },
    });

    const invoice = salesReturn.salesInvoiceId
      ? await prisma.salesInvoice.findFirst({ where: { id: salesReturn.salesInvoiceId, tenantId }, include: { customer: true } })
      : null;
    const invoiceIsPosted = invoice?.postingStatus === "Posted";

    const result = await prisma.$transaction(async (tx) => {
      let creditValue = 0;
      for (const line of linesWithDetail) {
        const unitCost =
          line.unitCost && Number(line.unitCost) > 0 ? Number(line.unitCost) : Number(line.item.averageCost ?? 0);

        await postStockMovement(tx, {
          tenantId,
          itemId: line.itemId,
          warehouseId: salesReturn.warehouseId,
          batchNo: line.batchNo,
          qtyIn: Number(line.returnQty),
          unitCost,
          sourceModule: "Sales",
          sourceDocType: "SalesReturn",
          sourceDocId: salesReturn.id,
        });

        if (line.unitPrice) {
          creditValue += Number(line.returnQty) * Number(line.unitPrice);
        }
      }

      await tx.salesReturn.update({ where: { id: salesReturn.id }, data: { status: "Posted" } });

      if (!invoiceIsPosted || creditValue <= 0 || !invoice) {
        return { creditNote: null };
      }

      const creditNoteNo = await nextDocumentNumber(tx, { tenantId, companyId, moduleCode: "CustomerCreditNote", defaultPrefix: "CN" });
      const creditNote = await tx.customerCreditNote.create({
        data: {
          tenantId,
          creditNoteNo,
          customerId: salesReturn.customerId,
          salesReturnId: salesReturn.id,
          salesInvoiceId: invoice.id,
          amount: creditValue,
        },
      });

      const revenueAccount = await resolveCoaByCode(tx, tenantId, companyId, "REVENUE-CONTROL");
      const arControl =
        (invoice.customer?.receivableGlId && (await tx.chartOfAccount.findUnique({ where: { id: invoice.customer.receivableGlId } }))) ||
        (await resolveCoaByCode(tx, tenantId, companyId, "AR-CONTROL"));

      if (revenueAccount && arControl) {
        await postJournal(tx, {
          tenantId,
          companyId,
          sourceModule: "Sales",
          sourceDocId: creditNote.id,
          lines: [
            { accountId: revenueAccount.id, debit: creditValue },
            { accountId: arControl.id, credit: creditValue },
          ],
        });
        await tx.customerCreditNote.update({ where: { id: creditNote.id }, data: { postingStatus: "Posted" } });
      } else {
        await recordPostingException(tx, {
          tenantId,
          sourceModule: "Sales",
          sourceDocId: creditNote.id,
          exceptionType: "Missing GL",
          message: "REVENUE-CONTROL or AR-CONTROL account not configured for this company",
        });
      }

      return { creditNote };
    });

    const updated = await prisma.salesReturn.findUnique({ where: { id: salesReturn.id }, include: { lines: true } });
    res.json({ ...updated, creditNote: result.creditNote });
  })
);

router.get(
  "/customer-credit-notes",
  requirePermission("Sales.CustomerCreditNote.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.query.customerId) where.customerId = req.query.customerId;
    const items = await prisma.customerCreditNote.findMany({ where, orderBy: { createdAt: "desc" } });
    res.json({ data: items });
  })
);

// --- Sales Reports -----------------------------------------------------------
// BRD "Reports" module's sales slice, derived from posted SalesInvoice/
// SalesInvoiceLine - no separate reporting tables, same rebuildable
// principle as the Inventory reports.

/**
 * Daily sales totals over a date range, optionally sliced by branch,
 * channel, or POS/Wholesale salesType.
 */
router.get(
  "/reports/sales-summary",
  requirePermission("Sales.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      fromDate: z.coerce.date(),
      toDate: z.coerce.date(),
      branchId: z.string().uuid().optional(),
      salesChannelId: z.string().uuid().optional(),
      salesType: z.enum(["POS", "Wholesale"]).optional(),
    });
    const { fromDate, toDate, branchId, salesChannelId, salesType } = schema.parse(req.query);

    const invoices = await prisma.salesInvoice.findMany({
      where: {
        tenantId,
        postingStatus: "Posted",
        businessDate: { gte: fromDate, lte: toDate },
        ...(branchId ? { branchId } : {}),
        ...(salesChannelId ? { salesChannelId } : {}),
        ...(salesType ? { salesType } : {}),
      },
    });

    const byDay = new Map<string, { businessDate: string; invoiceCount: number; gross: number; discount: number; tax: number; net: number }>();
    for (const inv of invoices) {
      const key = inv.businessDate.toISOString().slice(0, 10);
      const entry = byDay.get(key) ?? { businessDate: key, invoiceCount: 0, gross: 0, discount: 0, tax: 0, net: 0 };
      entry.invoiceCount += 1;
      entry.gross += Number(inv.gross);
      entry.discount += Number(inv.discount);
      entry.tax += Number(inv.tax);
      entry.net += Number(inv.net);
      byDay.set(key, entry);
    }
    const data = [...byDay.values()].sort((a, b) => a.businessDate.localeCompare(b.businessDate));

    res.json({
      data,
      totals: {
        invoiceCount: invoices.length,
        gross: invoices.reduce((s, i) => s + Number(i.gross), 0),
        discount: invoices.reduce((s, i) => s + Number(i.discount), 0),
        tax: invoices.reduce((s, i) => s + Number(i.tax), 0),
        net: invoices.reduce((s, i) => s + Number(i.net), 0),
      },
    });
  })
);

/**
 * Items ranked by revenue (qty * unitPrice) over a date range, from posted
 * invoice lines. Returns both the top and bottom `limit` items in one call
 * (best AND worst sellers) since they're the same underlying ranked list.
 * Lines with no itemId (unmapped POS SKUs, posItemCode-only) are excluded -
 * nothing to rank them against in the item master.
 */
router.get(
  "/reports/best-sellers",
  requirePermission("Sales.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      fromDate: z.coerce.date(),
      toDate: z.coerce.date(),
      branchId: z.string().uuid().optional(),
      limit: z.coerce.number().int().positive().max(100).default(20),
    });
    const { fromDate, toDate, branchId, limit } = schema.parse(req.query);

    const lines = await prisma.salesInvoiceLine.findMany({
      where: {
        tenantId,
        itemId: { not: null },
        salesInvoice: {
          tenantId,
          postingStatus: "Posted",
          businessDate: { gte: fromDate, lte: toDate },
          ...(branchId ? { branchId } : {}),
        },
      },
      include: { item: true },
    });

    const byItem = new Map<string, { itemId: string; itemCode: string; itemName: string; qty: number; revenue: number }>();
    for (const line of lines) {
      if (!line.itemId || !line.item) continue;
      const entry = byItem.get(line.itemId) ?? { itemId: line.itemId, itemCode: line.item.code, itemName: line.item.name, qty: 0, revenue: 0 };
      entry.qty += Number(line.qty);
      entry.revenue += Number(line.qty) * Number(line.unitPrice);
      byItem.set(line.itemId, entry);
    }
    const ranked = [...byItem.values()].sort((a, b) => b.revenue - a.revenue);

    res.json({
      topSellers: ranked.slice(0, limit),
      worstSellers: ranked.slice(-limit).reverse(),
    });
  })
);

/** POS vs Wholesale split, and per-channel split within that, by net revenue. */
router.get(
  "/reports/channel-mix",
  requirePermission("Sales.Reports.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      fromDate: z.coerce.date(),
      toDate: z.coerce.date(),
      branchId: z.string().uuid().optional(),
    });
    const { fromDate, toDate, branchId } = schema.parse(req.query);

    const invoices = await prisma.salesInvoice.findMany({
      where: {
        tenantId,
        postingStatus: "Posted",
        businessDate: { gte: fromDate, lte: toDate },
        ...(branchId ? { branchId } : {}),
      },
      include: { salesChannel: true },
    });

    const bySalesType = new Map<string, { salesType: string; invoiceCount: number; net: number }>();
    const byChannel = new Map<string, { channelCode: string; channelName: string; invoiceCount: number; net: number }>();
    for (const inv of invoices) {
      const typeEntry = bySalesType.get(inv.salesType) ?? { salesType: inv.salesType, invoiceCount: 0, net: 0 };
      typeEntry.invoiceCount += 1;
      typeEntry.net += Number(inv.net);
      bySalesType.set(inv.salesType, typeEntry);

      const channelKey = inv.salesChannel?.code ?? "UNASSIGNED";
      const channelEntry = byChannel.get(channelKey) ?? {
        channelCode: channelKey,
        channelName: inv.salesChannel?.name ?? "Unassigned",
        invoiceCount: 0,
        net: 0,
      };
      channelEntry.invoiceCount += 1;
      channelEntry.net += Number(inv.net);
      byChannel.set(channelKey, channelEntry);
    }

    res.json({
      bySalesType: [...bySalesType.values()].sort((a, b) => b.net - a.net),
      byChannel: [...byChannel.values()].sort((a, b) => b.net - a.net),
      totalNet: invoices.reduce((s, i) => s + Number(i.net), 0),
    });
  })
);

export default router;
