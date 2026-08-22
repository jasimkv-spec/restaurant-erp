/**
 * Seed script for the Restaurant ERP MVP.
 *
 * Creates one demo tenant with the minimum master data needed to walk the
 * full Procure-to-Pay -> Inventory -> Recipe -> Sales -> Consumption ->
 * Finance chain described in the BRD's "Key Business Workflows" (section 6),
 * plus a login you can use immediately:
 *
 *   Tenant code / subdomain : demo
 *   Login email             : admin@demo.local
 *   Login password          : Passw0rd!
 *
 * Run with: npm run seed
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding Restaurant ERP MVP demo data...");

  const currency = await prisma.currency.upsert({
    where: { code: "AED" },
    update: {},
    create: { code: "AED", name: "UAE Dirham", decimalPrecision: 2 },
  });

  const country = await prisma.country.upsert({
    where: { code: "AE" },
    update: {},
    create: { code: "AE", name: "United Arab Emirates" },
  });
  const city = await prisma.city.upsert({
    where: { countryId_code: { countryId: country.id, code: "DXB" } },
    update: {},
    create: { countryId: country.id, code: "DXB", name: "Dubai" },
  });

  const plan = await prisma.subscriptionPlan.upsert({
    where: { code: "STARTER" },
    update: {},
    create: { code: "STARTER", name: "Starter", billingCycle: "Monthly", basePrice: 0 },
  });

  const tenant = await prisma.tenant.upsert({
    where: { code: "demo" },
    update: {},
    create: {
      code: "demo",
      name: "Demo Restaurant Group",
      subdomain: "demo",
      planId: plan.id,
      databaseMode: "Shared",
      status: "Active",
      baseCurrencyId: currency.id,
    },
  });

  const moduleCodes = [
    "Admin",
    "Security",
    "Inventory",
    "Procurement",
    "Recipe",
    "Sales",
    "Consumption",
    "Finance",
    "Workflow",
    "SaaS",
  ];
  for (const moduleCode of moduleCodes) {
    await prisma.tenantModule.upsert({
      where: { tenantId_moduleCode: { tenantId: tenant.id, moduleCode } },
      update: { enabled: true },
      create: { tenantId: tenant.id, moduleCode, enabled: true },
    });
  }

  const company = await prisma.company.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "HQ" } },
    update: {},
    create: {
      tenantId: tenant.id,
      code: "HQ",
      name: "Demo Restaurant Group LLC",
      baseCurrencyId: currency.id,
      dateFormat: "dd-MM-yyyy",
    },
  });

  // Master-data code prefixes - visible in the Master Series screen from
  // day one rather than only appearing after the first vendor/customer is
  // saved (nextMasterNumber would create these lazily otherwise).
  await prisma.masterSeries.upsert({
    where: { tenantId_entityType: { tenantId: tenant.id, entityType: "Vendor" } },
    update: {},
    create: { tenantId: tenant.id, entityType: "Vendor", prefix: "SUP", digitLength: 4 },
  });
  await prisma.masterSeries.upsert({
    where: { tenantId_entityType: { tenantId: tenant.id, entityType: "Customer" } },
    update: {},
    create: { tenantId: tenant.id, entityType: "Customer", prefix: "CUS", digitLength: 4 },
  });
  await prisma.masterSeries.upsert({
    where: { tenantId_entityType: { tenantId: tenant.id, entityType: "Item" } },
    update: {},
    create: { tenantId: tenant.id, entityType: "Item", prefix: "ITM", digitLength: 4 },
  });
  await prisma.masterSeries.upsert({
    where: { tenantId_entityType: { tenantId: tenant.id, entityType: "RawMaterial" } },
    update: {},
    create: { tenantId: tenant.id, entityType: "RawMaterial", prefix: "RM", digitLength: 4 },
  });
  await prisma.masterSeries.upsert({
    where: { tenantId_entityType: { tenantId: tenant.id, entityType: "MenuItem" } },
    update: {},
    create: { tenantId: tenant.id, entityType: "MenuItem", prefix: "MEN", digitLength: 4 },
  });

  const branch = await prisma.branch.upsert({
    where: { tenantId_companyId_code: { tenantId: tenant.id, companyId: company.id, code: "BR01" } },
    update: {},
    create: {
      tenantId: tenant.id,
      companyId: company.id,
      code: "BR01",
      name: "Main Outlet",
      branchType: "Outlet",
    },
  });

  const warehouse = await prisma.warehouse.upsert({
    where: { tenantId_branchId_code: { tenantId: tenant.id, branchId: branch.id, code: "WH-RM" } },
    update: {},
    create: {
      tenantId: tenant.id,
      branchId: branch.id,
      code: "WH-RM",
      name: "Main Kitchen Store",
      warehouseType: "Raw Material",
    },
  });

  await prisma.branch.update({ where: { id: branch.id }, data: { defaultWarehouseId: warehouse.id } });

  // In-transit holding warehouse - the mid-point stock balance for inter-
  // branch transfers between Transfer Out and Transfer In.
  await prisma.warehouse.upsert({
    where: { tenantId_branchId_code: { tenantId: tenant.id, branchId: branch.id, code: "WH-TRANSIT" } },
    update: {},
    create: {
      tenantId: tenant.id,
      branchId: branch.id,
      code: "WH-TRANSIT",
      name: "In-Transit Holding",
      warehouseType: "In-Transit",
      isInTransit: true,
    },
  });

  await prisma.area.upsert({
    where: { tenantId_cityId_code: { tenantId: tenant.id, cityId: city.id, code: "DOWNTOWN" } },
    update: {},
    create: { tenantId: tenant.id, cityId: city.id, code: "DOWNTOWN", name: "Downtown Dubai" },
  });

  const now = new Date();
  await prisma.financialPeriod.upsert({
    where: {
      tenantId_companyId_fiscalYear_monthNo: {
        tenantId: tenant.id,
        companyId: company.id,
        fiscalYear: now.getUTCFullYear(),
        monthNo: now.getUTCMonth() + 1,
      },
    },
    update: {},
    create: {
      tenantId: tenant.id,
      companyId: company.id,
      fiscalYear: now.getUTCFullYear(),
      monthNo: now.getUTCMonth() + 1,
      startDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      endDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)),
      inventoryStatus: "Open",
      financeStatus: "Open",
    },
  });

  // --- Account groups: financial-statement classification the chart of
  // accounts rolls up into (see GET /finance/reports/trial-balance-by-group).
  const groupSeed: { code: string; name: string; natureType: "Asset" | "Liability" | "Equity" | "Revenue" | "Expense"; sortOrder: number }[] = [
    { code: "CURRENT-ASSETS", name: "Current Assets", natureType: "Asset", sortOrder: 10 },
    { code: "BANK-CASH", name: "Bank and Cash", natureType: "Asset", sortOrder: 20 },
    { code: "CURRENT-LIABILITIES", name: "Current Liabilities", natureType: "Liability", sortOrder: 30 },
    { code: "EQUITY", name: "Equity", natureType: "Equity", sortOrder: 40 },
    { code: "DIRECT-INCOME", name: "Direct Income", natureType: "Revenue", sortOrder: 50 },
    { code: "DIRECT-EXPENSES", name: "Direct Expenses (COGS)", natureType: "Expense", sortOrder: 60 },
    { code: "INDIRECT-EXPENSES", name: "Indirect Expenses", natureType: "Expense", sortOrder: 70 },
  ];
  const accountGroup: Record<string, string> = {};
  for (const g of groupSeed) {
    const record = await prisma.accountGroup.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: g.code } },
      update: {},
      create: { tenantId: tenant.id, ...g },
    });
    accountGroup[g.code] = record.id;
  }

  // --- Chart of accounts: control/clearing accounts the posting services
  // look up by code (see src/services/coaLookup.ts). --------------------
  const coaSeed: { code: string; name: string; accountType: "Asset" | "Liability" | "Equity" | "Revenue" | "Expense"; groupCode: string }[] = [
    { code: "INVENTORY-CONTROL", name: "Inventory Asset - Control", accountType: "Asset", groupCode: "CURRENT-ASSETS" },
    { code: "GRN-CLEARING", name: "GRN Clearing (Accrual)", accountType: "Liability", groupCode: "CURRENT-LIABILITIES" },
    { code: "AP-CONTROL", name: "Accounts Payable - Control", accountType: "Liability", groupCode: "CURRENT-LIABILITIES" },
    { code: "AR-CONTROL", name: "Accounts Receivable - Control", accountType: "Asset", groupCode: "CURRENT-ASSETS" },
    { code: "CASH-CONTROL", name: "Cash and Bank - Control", accountType: "Asset", groupCode: "BANK-CASH" },
    { code: "SALES-CLEARING", name: "Sales Settlement Clearing", accountType: "Asset", groupCode: "CURRENT-ASSETS" },
    { code: "REVENUE-CONTROL", name: "Sales Revenue - Control", accountType: "Revenue", groupCode: "DIRECT-INCOME" },
    { code: "TAX-OUTPUT", name: "VAT Output Payable", accountType: "Liability", groupCode: "CURRENT-LIABILITIES" },
    { code: "TAX-INPUT", name: "VAT Input Receivable", accountType: "Asset", groupCode: "CURRENT-ASSETS" },
    { code: "COGS-CONTROL", name: "Food Cost / COGS - Control", accountType: "Expense", groupCode: "DIRECT-EXPENSES" },
    { code: "STOCK-ADJUSTMENT", name: "Stock Adjustment Variance", accountType: "Expense", groupCode: "INDIRECT-EXPENSES" },
    { code: "VENDOR-ADVANCE", name: "Vendor Advances", accountType: "Asset", groupCode: "CURRENT-ASSETS" },
    { code: "CUSTOMER-ADVANCE", name: "Customer Advances", accountType: "Liability", groupCode: "CURRENT-LIABILITIES" },
  ];
  const coa: Record<string, string> = {};
  for (const acc of coaSeed) {
    const { groupCode, ...accData } = acc;
    const record = await prisma.chartOfAccount.upsert({
      where: { tenantId_companyId_code: { tenantId: tenant.id, companyId: company.id, code: acc.code } },
      update: {},
      create: { tenantId: tenant.id, companyId: company.id, ...accData, groupId: accountGroup[groupCode], isControlAccount: true },
    });
    coa[acc.code] = record.id;
  }

  // BankAccount has no natural unique business key in the MVP schema, so we
  // upsert against a fixed seed id to keep this script idempotent.
  await prisma.bankAccount.upsert({
    where: { id: "seed-cash-account-placeholder" },
    update: {},
    create: {
      id: "seed-cash-account-placeholder",
      tenantId: tenant.id,
      companyId: company.id,
      accountId: coa["CASH-CONTROL"],
      bankName: "Main Cash Drawer",
    },
  });

  // --- Roles & permission catalog ---------------------------------------
  const tenantAdminRole = await prisma.role.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "TenantAdmin" } },
    update: {},
    create: { tenantId: tenant.id, code: "TenantAdmin", name: "Tenant Admin" },
  });
  const storeKeeperRole = await prisma.role.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "StoreKeeper" } },
    update: {},
    create: { tenantId: tenant.id, code: "StoreKeeper", name: "Storekeeper" },
  });
  const kitchenManagerRole = await prisma.role.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "KitchenManager" } },
    update: {},
    create: { tenantId: tenant.id, code: "KitchenManager", name: "Kitchen Manager" },
  });
  const financeManagerRole = await prisma.role.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "FinanceManager" } },
    update: {},
    create: { tenantId: tenant.id, code: "FinanceManager", name: "Finance Manager" },
  });

  // --- Permission catalog + role grants ------------------------------------
  // Every "moduleCode.screenCode.actionCode" string checked by
  // requirePermission() across src/modules/**, plus the auto-generated
  // View/Create/Edit permissions for every crudRouter-backed master screen.
  // Seeded here so non-TenantAdmin roles (which do NOT bypass the permission
  // check - see src/middleware/rbac.ts) actually have something to check
  // against once you assign them to a user.
  const CRUD_SCREENS = [
    "Admin.Branch", "Admin.Company", "Admin.CostCentre", "Admin.DocumentSeries",
    "Admin.FinancialPeriod", "Admin.MasterSeries", "Admin.ProfitCentre", "Admin.Warehouse",
    "Finance.AccountGroup", "Finance.BankAccount", "Finance.ChartOfAccount",
    "Inventory.Item", "Inventory.ItemCategory", "Inventory.ItemPrice", "Inventory.ItemVendorMapping",
    "Inventory.ItemBranchSetting", "Inventory.ItemType", "Inventory.MenuCategory",
    "Inventory.ProductGroup", "Inventory.ProductSubgroup", "Inventory.ProductFamily", "Inventory.Brand",
    "Inventory.PriceGroup",
    "Masters.Area", "Masters.PaymentMethod", "Masters.ShipmentType", "Masters.Tax", "Masters.TaxGroup", "Masters.Term", "Masters.Uom",
    "Procurement.Vendor", "Procurement.AdditionalCostType",
    "Sales.Customer", "Sales.PosConnector", "Sales.PosItemMapping", "Sales.SalesChannel",
    "Security.Role",
    "Workflow.ApprovalWorkflow", "Workflow.DocumentType",
  ];
  const CUSTOM_PERMISSIONS = [
    "Admin.CompanyPolicy.Edit", "Admin.CompanyPolicy.View",
    "Consumption.ConsumptionException.View", "Consumption.ConsumptionPosting.Post", "Consumption.ConsumptionPosting.View",
    "Consumption.Reports.View",
    "Finance.PostingException.Edit", "Finance.PostingException.View", "Finance.Reports.View",
    "Finance.ChequeRegister.View", "Finance.ChequeRegister.Edit",
    "Finance.BankStatementLine.Create", "Finance.BankStatementLine.View", "Finance.BankStatementLine.Edit",
    "Inventory.Menu.Edit", "Inventory.Menu.View",
    "Masters.Bank.Create", "Masters.Bank.View",
    "Accounting.JournalEntry.Post", "Accounting.JournalEntry.View",
    "Accounting.CustomerReceipt.Create", "Accounting.CustomerReceipt.Post", "Accounting.CustomerReceipt.View",
    "Accounting.CustomerCreditNote.Create", "Accounting.CustomerCreditNote.Post", "Accounting.CustomerCreditNote.View",
    "Accounting.VendorDebitNote.Create", "Accounting.VendorDebitNote.Post", "Accounting.VendorDebitNote.View",
    "Accounting.ContraVoucher.Create", "Accounting.ContraVoucher.Post", "Accounting.ContraVoucher.View",
    "Inventory.ItemGlMapping.Create", "Inventory.ItemGlMapping.View", "Inventory.Item.ViewCost", "Inventory.StockBalance.View", "Inventory.StockLedger.View",
    "Inventory.Reports.View",
    "Inventory.StockTransfer.Approve", "Inventory.StockTransfer.Create", "Inventory.StockTransfer.Dispatch",
    "Inventory.StockTransfer.Receive", "Inventory.StockTransfer.Submit", "Inventory.StockTransfer.View",
    "Inventory.StockAdjustment.Approve", "Inventory.StockAdjustment.Create", "Inventory.StockAdjustment.Post",
    "Inventory.StockAdjustment.Submit", "Inventory.StockAdjustment.View",
    "Masters.Country.View", "Masters.Country.Create", "Masters.City.View", "Masters.City.Create",
    "Masters.Currency.Create", "Masters.Currency.Edit", "Masters.Currency.View",
    "Masters.UomConversion.Create", "Masters.UomConversion.Edit", "Masters.UomConversion.View",
    "Procurement.Grn.Create", "Procurement.Grn.Post", "Procurement.Grn.View",
    "Procurement.GoodsReturn.Create", "Procurement.GoodsReturn.Post", "Procurement.GoodsReturn.View",
    "Procurement.MaterialRequest.Approve", "Procurement.MaterialRequest.Create", "Procurement.MaterialRequest.Edit",
    "Procurement.MaterialRequest.Submit", "Procurement.MaterialRequest.View",
    "Procurement.MrConsolidation.Create", "Procurement.MrConsolidation.View",
    "Procurement.PurchaseInvoice.Create", "Procurement.PurchaseInvoice.Post", "Procurement.PurchaseInvoice.View",
    "Procurement.PurchaseOrder.Approve", "Procurement.PurchaseOrder.Create", "Procurement.PurchaseOrder.Edit",
    "Procurement.PurchaseOrder.Submit", "Procurement.PurchaseOrder.View",
    "Procurement.Rfq.Approve", "Procurement.Rfq.Create", "Procurement.Rfq.Edit", "Procurement.Rfq.Submit", "Procurement.Rfq.View",
    "Procurement.VendorDebitNote.View", "Procurement.Vendor.ViewBankDetails",
    "Procurement.VendorPayment.Create", "Procurement.VendorPayment.Post", "Procurement.VendorPayment.View",
    "Procurement.Reports.View",
    "Recipe.Recipe.Create", "Recipe.Recipe.View", "Recipe.RecipeVersion.Approve", "Recipe.RecipeVersion.Create",
    "Recipe.ProductionPosting.Create", "Recipe.ProductionPosting.Post", "Recipe.ProductionPosting.View",
    "Sales.SalesImport.Import", "Sales.SalesImport.View", "Sales.SalesInvoice.Create", "Sales.SalesInvoice.Post", "Sales.SalesInvoice.View",
    "Sales.SalesQuote.Create", "Sales.SalesQuote.Edit", "Sales.SalesQuote.Submit", "Sales.SalesQuote.View",
    "Sales.DeliveryOrder.Create", "Sales.DeliveryOrder.Deliver", "Sales.DeliveryOrder.View",
    "Sales.SalesReturn.Create", "Sales.SalesReturn.Post", "Sales.SalesReturn.View",
    "Sales.CustomerCreditNote.View", "Sales.Reports.View",
    "Security.AuditLog.View", "Security.BranchAccess.Edit", "Security.Permission.View",
    "Security.RolePermission.Edit", "Security.RolePermission.View", "Security.UserRole.Edit",
    "Security.Users.Create", "Security.Users.Edit", "Security.Users.View", "Security.WarehouseAccess.Edit",
    "Workflow.ApprovalTask.Approve", "Workflow.ApprovalTask.View",
    "Workflow.DocumentAttachment.Create", "Workflow.DocumentAttachment.Edit", "Workflow.DocumentAttachment.View",
    "Workflow.Notification.Edit", "Workflow.Notification.View",
  ];
  const allPermissionKeys = [
    ...CRUD_SCREENS.flatMap((s) => ["View", "Create", "Edit"].map((a) => `${s}.${a}`)),
    ...CUSTOM_PERMISSIONS,
  ];

  const permissionByKey = new Map<string, string>(); // key -> permission id
  for (const key of allPermissionKeys) {
    const [moduleCode, screenCode, actionCode] = key.split(".");
    const permission = await prisma.permission.upsert({
      where: { moduleCode_screenCode_actionCode: { moduleCode, screenCode, actionCode } },
      update: {},
      create: { moduleCode, screenCode, actionCode },
    });
    permissionByKey.set(key, permission.id);
  }

  async function grantByPrefix(roleId: string, prefixes: string[]) {
    for (const key of allPermissionKeys) {
      if (!prefixes.some((p) => key === p || key.startsWith(p))) continue;
      const permissionId = permissionByKey.get(key)!;
      await prisma.rolePermission.upsert({
        where: { tenantId_roleId_permissionId: { tenantId: tenant.id, roleId, permissionId } },
        update: { allowed: true },
        create: { tenantId: tenant.id, roleId, permissionId, allowed: true },
      });
    }
  }

  // TenantAdmin already bypasses requirePermission() entirely (see
  // src/middleware/rbac.ts), but grant everything anyway so the role
  // reflects "full access" if that bypass is ever removed.
  await grantByPrefix(tenantAdminRole.id, [""]);
  await grantByPrefix(storeKeeperRole.id, [
    "Inventory.", "Procurement.MaterialRequest.", "Procurement.MrConsolidation.", "Procurement.Grn.",
    "Procurement.Rfq.", "Procurement.PurchaseOrder.", "Procurement.GoodsReturn.", "Procurement.Reports.View",
    "Procurement.AdditionalCostType.",
  ]);
  await grantByPrefix(kitchenManagerRole.id, [
    "Recipe.", "Inventory.Item.View", "Inventory.ItemCategory.View", "Consumption.",
  ]);
  await grantByPrefix(financeManagerRole.id, [
    "Finance.", "Accounting.", "Procurement.PurchaseInvoice.", "Procurement.VendorPayment.", "Procurement.PurchaseOrder.View",
    "Procurement.VendorDebitNote.View", "Procurement.Vendor.ViewBankDetails", "Inventory.Item.ViewCost", "Inventory.Reports.View",
    "Sales.Reports.View", "Procurement.Reports.View", "Consumption.Reports.View", "Procurement.AdditionalCostType.",
  ]);

  // --- Admin user (TenantAdmin bypasses per-permission checks - see
  // src/middleware/rbac.ts) ------------------------------------------------
  const adminEmail = "admin@demo.local";
  const passwordHash = await bcrypt.hash("Passw0rd!", 10);
  const adminUser = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: adminEmail } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: adminEmail,
      displayName: "Demo Tenant Admin",
      passwordHash,
      status: "Active",
    },
  });
  const existingAssignment = await prisma.userRole.findFirst({
    where: { tenantId: tenant.id, userId: adminUser.id, roleId: tenantAdminRole.id },
  });
  if (!existingAssignment) {
    await prisma.userRole.create({ data: { tenantId: tenant.id, userId: adminUser.id, roleId: tenantAdminRole.id, companyId: company.id } });
  }
  await prisma.userBranchAccess.upsert({
    where: { tenantId_userId_branchId: { tenantId: tenant.id, userId: adminUser.id, branchId: branch.id } },
    update: {},
    create: { tenantId: tenant.id, userId: adminUser.id, branchId: branch.id },
  });

  // --- Demo approval workflow (BRD "basic approval workflow") --------------
  // Two-level example: a submitted Material Request first goes to whoever
  // holds StoreKeeper (branch-level check), then FinanceManager (spend
  // sign-off). src/services/approvalService.ts creates the actual tasks
  // when a document is submitted, using this row's approvalLevelsJson.
  const existingWorkflow = await prisma.approvalWorkflow.findFirst({
    where: { tenantId: tenant.id, moduleCode: "Procurement.MaterialRequest" },
  });
  if (!existingWorkflow) {
    await prisma.approvalWorkflow.create({
      data: {
        tenantId: tenant.id,
        moduleCode: "Procurement.MaterialRequest",
        approvalLevelsJson: [
          { level: 1, approverRoleCode: "StoreKeeper" },
          { level: 2, approverRoleCode: "FinanceManager" },
        ],
      },
    });
  }

  // Second demo workflow showing the conditionJson "approval limit" path:
  // Purchase Orders under AED 5,000 skip approval entirely; at or above it,
  // FinanceManager sign-off is required.
  const existingPoWorkflow = await prisma.approvalWorkflow.findFirst({
    where: { tenantId: tenant.id, moduleCode: "Procurement.PurchaseOrder" },
  });
  if (!existingPoWorkflow) {
    await prisma.approvalWorkflow.create({
      data: {
        tenantId: tenant.id,
        moduleCode: "Procurement.PurchaseOrder",
        conditionJson: { minAmount: 5000 },
        approvalLevelsJson: [{ level: 1, approverRoleCode: "FinanceManager" }],
      },
    });
  }

  // --- Document Types (for the Vendor/Customer attachments panel) ---------
  // moduleCode here matches the same "Module.Screen" namespace as
  // permission keys - the frontend passes this same string as the
  // moduleCode query param when listing/uploading attachments for that
  // master, and the Document Types admin screen groups rows by it. Employee
  // and transaction-level document types (per the user's own forward-
  // looking note) get added the same way later, no schema change needed.
  const documentTypeSeed: { moduleCode: string; name: string; expiryRequired?: boolean; mandatory?: boolean }[] = [
    { moduleCode: "Procurement.Vendor", name: "Trade License", expiryRequired: true, mandatory: true },
    { moduleCode: "Procurement.Vendor", name: "VAT Certificate", expiryRequired: true },
    { moduleCode: "Procurement.Vendor", name: "Bank Details Letter" },
    { moduleCode: "Procurement.Vendor", name: "Other" },
    { moduleCode: "Sales.Customer", name: "Trade License", expiryRequired: true },
    { moduleCode: "Sales.Customer", name: "VAT Certificate", expiryRequired: true },
    { moduleCode: "Sales.Customer", name: "Credit Agreement" },
    { moduleCode: "Sales.Customer", name: "Other" },
    { moduleCode: "Procurement.MaterialRequest", name: "Quotation" },
    { moduleCode: "Procurement.MaterialRequest", name: "Specification" },
    { moduleCode: "Procurement.MaterialRequest", name: "Other" },
  ];
  for (const dt of documentTypeSeed) {
    await prisma.documentType.upsert({
      where: { tenantId_moduleCode_name: { tenantId: tenant.id, moduleCode: dt.moduleCode, name: dt.name } },
      update: {},
      create: { tenantId: tenant.id, ...dt },
    });
  }

  // --- Inventory masters ---------------------------------------------------
  const uomKg = await prisma.uom.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "KG" } },
    update: {},
    create: { tenantId: tenant.id, code: "KG", name: "Kilogram", decimalPrecision: 3 },
  });
  const uomPc = await prisma.uom.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "PC" } },
    update: {},
    create: { tenantId: tenant.id, code: "PC", name: "Piece", decimalPrecision: 0 },
  });

  const tax = await prisma.tax.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "VAT5" } },
    update: {},
    create: { tenantId: tenant.id, code: "VAT5", name: "VAT 5%", rate: 5, taxType: "VAT" },
  });

  await prisma.paymentMethod.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "CASH" } },
    update: {},
    create: { tenantId: tenant.id, code: "CASH", name: "Cash", type: "Cash" },
  });
  await prisma.paymentMethod.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "CARD" } },
    update: {},
    create: { tenantId: tenant.id, code: "CARD", name: "Card", type: "Card" },
  });

  const term = await prisma.term.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "NET30" } },
    update: {},
    create: { tenantId: tenant.id, code: "NET30", name: "Net 30 Days", days: 30 },
  });

  // Landed-cost types (Transportation/Insurance/Handling) so the GRN and
  // Purchase Invoice's Additional Costs picker isn't empty on first use.
  // glAccountId is left unset - admins map each to their own chart of
  // accounts from the Additional Cost Types screen once it's set up.
  for (const [code, name] of [
    ["FREIGHT", "Transportation / Freight"],
    ["INSURANCE", "Insurance"],
    ["HANDLING", "Handling"],
  ] as const) {
    await prisma.additionalCostType.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code } },
      update: {},
      create: { tenantId: tenant.id, code, name },
    });
  }

  // Item Type master (separate axis from itemType above, which only routes
  // a product to the Raw Material/Menu/Item screen) - Raw Materials Master
  // pre-selects "STOCK" for every new record; the rest are just a starting
  // point the user can extend from the Item Types screen.
  const itemTypeStock = await prisma.itemType.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "STOCK" } },
    update: {},
    create: { tenantId: tenant.id, code: "STOCK", name: "Stock", isStock: true },
  });
  await prisma.itemType.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "NONSTOCK" } },
    update: {},
    create: { tenantId: tenant.id, code: "NONSTOCK", name: "Non-Stock", isStock: false },
  });
  await prisma.itemType.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "SERVICE" } },
    update: {},
    create: { tenantId: tenant.id, code: "SERVICE", name: "Service", isStock: false },
  });
  await prisma.itemType.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "CONSUMABLE" } },
    update: {},
    create: { tenantId: tenant.id, code: "CONSUMABLE", name: "Consumable", isStock: true },
  });
  await prisma.itemType.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "ASSET" } },
    update: {},
    create: { tenantId: tenant.id, code: "ASSET", name: "Fixed Asset", isStock: false },
  });

  const category = await prisma.itemCategory.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "RAW" } },
    update: {},
    create: {
      tenantId: tenant.id,
      code: "RAW",
      name: "Raw Materials - Food",
      defaultInventoryGlId: coa["INVENTORY-CONTROL"],
      defaultCogsGlId: coa["COGS-CONTROL"],
    },
  });

  // A starter Item Category tree, structured the way a restaurant P&L
  // usually wants its food/COGS split: each of these can carry its own
  // Inventory/COGS account so items just pick a category and inherit the
  // right posting (per-item overrides still take priority - see
  // resolveItemGl() in coaLookup.ts). Group/Subgroup/Family stay purely
  // organizational (no GL) since that's not what they're used for.
  const foodChildren = [
    { code: "RAW-VEG", name: "Vegetables & Fruits" },
    { code: "RAW-MEAT", name: "Meat & Poultry" },
    { code: "RAW-SEA", name: "Seafood" },
    { code: "RAW-DAIRY", name: "Dairy & Eggs" },
    { code: "RAW-GROC", name: "Grocery & Dry Goods" },
    { code: "RAW-BAKE", name: "Bakery Ingredients" },
  ];
  for (const c of foodChildren) {
    await prisma.itemCategory.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: c.code } },
      update: {},
      create: {
        tenantId: tenant.id,
        code: c.code,
        name: c.name,
        parentId: category.id,
        defaultInventoryGlId: coa["INVENTORY-CONTROL"],
        defaultCogsGlId: coa["COGS-CONTROL"],
      },
    });
  }

  const beverageCategory = await prisma.itemCategory.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "BEV" } },
    update: {},
    create: {
      tenantId: tenant.id,
      code: "BEV",
      name: "Raw Materials - Beverage",
      defaultInventoryGlId: coa["INVENTORY-CONTROL"],
      defaultCogsGlId: coa["COGS-CONTROL"],
    },
  });
  const beverageChildren = [
    { code: "BEV-SOFT", name: "Soft Drinks & Juices" },
    { code: "BEV-HOT", name: "Tea & Coffee" },
    { code: "BEV-ALC", name: "Alcoholic Beverages" },
  ];
  for (const c of beverageChildren) {
    await prisma.itemCategory.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: c.code } },
      update: {},
      create: {
        tenantId: tenant.id,
        code: c.code,
        name: c.name,
        parentId: beverageCategory.id,
        defaultInventoryGlId: coa["INVENTORY-CONTROL"],
        defaultCogsGlId: coa["COGS-CONTROL"],
      },
    });
  }

  await prisma.itemCategory.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "PACK" } },
    update: {},
    create: {
      tenantId: tenant.id,
      code: "PACK",
      name: "Packaging & Disposables",
      defaultInventoryGlId: coa["INVENTORY-CONTROL"],
      defaultCogsGlId: coa["COGS-CONTROL"],
    },
  });
  await prisma.itemCategory.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "CONSUM" } },
    update: {},
    create: {
      tenantId: tenant.id,
      code: "CONSUM",
      name: "Consumables (Cleaning & Kitchen Supplies)",
    },
  });

  const menuCategory = await prisma.itemCategory.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "MENU" } },
    update: {},
    create: { tenantId: tenant.id, code: "MENU", name: "Menu / Finished Goods" },
  });
  const menuChildren = [
    { code: "MENU-FOOD", name: "Food Items" },
    { code: "MENU-BEV", name: "Beverage Items" },
    { code: "MENU-COMBO", name: "Combo / Meal Items" },
  ];
  for (const c of menuChildren) {
    await prisma.itemCategory.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: c.code } },
      update: {},
      create: { tenantId: tenant.id, code: c.code, name: c.name, parentId: menuCategory.id },
    });
  }

  // Fixed assets deliberately do NOT get an Item Category - equipment,
  // furniture, and similar capitalized purchases need depreciation
  // schedules and an asset lifecycle that Item Master has no fields for.
  // They belong in a dedicated Fixed Asset Register module (backlog),
  // matching SAP's separate Asset Accounting (FI-AA) vs Materials
  // Management (MM) split - not a category on the product master.

  const tomato = await prisma.item.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "RM-TOMATO" } },
    update: {},
    create: {
      tenantId: tenant.id,
      code: "RM-TOMATO",
      name: "Tomato",
      itemType: "Stock",
      itemTypeId: itemTypeStock.id,
      forPurchase: true,
      categoryId: category.id,
      baseUomId: uomKg.id,
      costingMethod: "Weighted Average",
      status: "Active",
    },
  });
  await prisma.itemGlMapping.upsert({
    where: { itemId: tomato.id },
    update: {},
    create: {
      tenantId: tenant.id,
      itemId: tomato.id,
      inventoryGlId: coa["INVENTORY-CONTROL"],
      cogsGlId: coa["COGS-CONTROL"],
    },
  });

  const burgerBun = await prisma.item.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "RM-BUN" } },
    update: {},
    create: {
      tenantId: tenant.id,
      code: "RM-BUN",
      name: "Burger Bun",
      itemType: "Stock",
      itemTypeId: itemTypeStock.id,
      forPurchase: true,
      categoryId: category.id,
      baseUomId: uomPc.id,
      costingMethod: "Weighted Average",
      status: "Active",
    },
  });
  await prisma.itemGlMapping.upsert({
    where: { itemId: burgerBun.id },
    update: {},
    create: { tenantId: tenant.id, itemId: burgerBun.id, inventoryGlId: coa["INVENTORY-CONTROL"], cogsGlId: coa["COGS-CONTROL"] },
  });

  const burger = await prisma.item.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "MENU-BURGER" } },
    update: {},
    create: {
      tenantId: tenant.id,
      code: "MENU-BURGER",
      name: "Classic Burger",
      itemType: "Menu",
      baseUomId: uomPc.id,
      costingMethod: "Weighted Average",
      status: "Active",
    },
  });

  await prisma.itemPrice.upsert({
    where: { id: "seed-burger-price-placeholder" },
    update: {},
    create: { id: "seed-burger-price-placeholder", tenantId: tenant.id, itemId: burger.id, branchId: branch.id, price: 25 },
  });

  // --- Vendor ---------------------------------------------------------------
  await prisma.vendor.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "V-FRESH01" } },
    update: {},
    create: {
      tenantId: tenant.id,
      code: "V-FRESH01",
      name: "Fresh Produce Supplier LLC",
      paymentTermsId: term.id,
      payableGlId: coa["AP-CONTROL"],
      status: "Active",
    },
  });

  // --- Sales channel ----------------------------------------------------
  await prisma.salesChannel.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "DINEIN" } },
    update: {},
    create: { tenantId: tenant.id, code: "DINEIN", name: "Dine-in", revenueGlId: coa["REVENUE-CONTROL"] },
  });

  // --- Recipe: Classic Burger = 0.15kg Tomato + 1 Bun -----------------------
  const existingRecipe = await prisma.recipe.findFirst({ where: { tenantId: tenant.id, outputItemId: burger.id } });
  const recipe =
    existingRecipe ??
    (await prisma.recipe.create({
      data: { tenantId: tenant.id, outputItemId: burger.id, recipeType: "Menu", defaultOutputQty: 1 },
    }));

  const existingVersion = await prisma.recipeVersion.findFirst({ where: { tenantId: tenant.id, recipeId: recipe.id } });
  if (!existingVersion) {
    await prisma.recipeVersion.create({
      data: {
        tenantId: tenant.id,
        recipeId: recipe.id,
        versionNo: 1,
        status: "Draft",
        ingredients: {
          create: [
            { tenantId: tenant.id, ingredientItemId: tomato.id, qty: 0.15, uomId: uomKg.id, wastagePct: 5 },
            { tenantId: tenant.id, ingredientItemId: burgerBun.id, qty: 1, uomId: uomPc.id, wastagePct: 0 },
          ],
        },
      },
    });
  }

  console.log("Seed complete.");
  console.log("--------------------------------------------------------");
  console.log(`Tenant code / X-Tenant-Code header : ${tenant.code}`);
  console.log(`Login email                        : ${adminEmail}`);
  console.log(`Login password                     : Passw0rd!`);
  console.log(`Company id                         : ${company.id}`);
  console.log(`Branch id                           : ${branch.id}`);
  console.log(`Warehouse id                         : ${warehouse.id}`);
  console.log("--------------------------------------------------------");
  console.log(
    "Next: POST /grns for tomato/bun against warehouse, then /grns/:id/post to bring stock in;\n" +
      "approve the burger recipe version; import a sales invoice via /sales/sales-import;\n" +
      "post it; then POST /consumption/generate to explode the recipe and book COGS."
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
