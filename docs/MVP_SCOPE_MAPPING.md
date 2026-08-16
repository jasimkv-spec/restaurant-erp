# MVP Scope Mapping

Traces the BRD's "Recommended MVP Scope" table (section 3) to what this
codebase implements. Base URL for everything except `/health`, `/saas`,
and `/auth` is `/api/<module>`, and every request needs an `X-Tenant-Code`
header plus (except `/auth/*`) a `Authorization: Bearer <token>` header.

| BRD MVP Module | Included Scope (BRD) | Implemented as |
|---|---|---|
| Admin and Setup | Company, branch, warehouse, cost/profit centre, financial periods, document numbering, policies | `/api/admin/*` full CRUD for all listed entities. Financial periods (`/financial-periods`) now actually gate postings - see `assertPeriodOpen()` in `src/services/periodService.ts`, called from both `postJournal()` and `postStockMovement()`. "Policies" (approval limits) is still schema-only (`posting_rules`) - see `docs/ARCHITECTURE.md`. |
| Security | Users, roles, action permissions, branch/warehouse access, audit log, sensitive field controls | `/api/security/*`. Action-based permission matrix is enforced via `requirePermission()` on every route. **Sensitive-field masking is wired** for the two fields that actually exist in MVP scope - `Vendor.bankName/bankAccountNo/iban` (behind `Procurement.Vendor.ViewBankDetails`) and `Item.standardCost/lastReceivedCost/averageCost` (behind `Inventory.Item.ViewCost`) - via a generic `sensitiveFields` option on `crudFactory.ts`'s CRUD router, masked to `null` with a `_masked` field list on the record for requesters who lack the permission. Salary masking has no field to mask yet - still deferred to HR/Payroll (Phase 2). Custom (non-CRUD-factory) read endpoints, like `/items/:id/pricing-summary`, are not yet covered by this masking - only the generic list/detail routes are. |
| Inventory Masters | Item master, category, UOM, conversions, batch/expiry, GL mapping, pricing basics | `/api/inventory/item-categories`, `/items` (now also `lastReceivedCost`, `averageCost`, GP%-ready pricing), `/item-gl-mappings`, `/item-prices` (multiple selling prices), `/item-vendor-mappings`, `/api/masters/uoms`, `/uom-conversions`. Batch/expiry are fields on GRN lines / stock ledger, not a separate master. |
| Procurement | MR, branch MR, MR consolidation, PO, GRN, goods return, purchase invoice, vendor payment | `/api/procurement/*` - material-requests (+submit/approve), RFQ (`/rfqs`, send/quote/select/convert-to-po), HO consolidation pool (`/material-requests/consolidation-pool`, `/mr-consolidations` with Internal/External fulfilment and convert-to-transfer), purchase-orders, grns (+post), **goods-returns** (+post, auto-raises a VendorDebitNote when the source GRN was already invoiced), purchase-invoices (+post, three-way match), vendor-payments (+post, Invoice/Advance mode, cheque fields). |
| Inventory Operations | Stock ledger, IBT, stock issue, consumption, stock take, adjustments, valuation | Stock ledger + weighted-average valuation (`src/services/stockService.ts`). **Inter-branch transfer** is a real two-leg dispatch/receive flow through a dedicated in-transit warehouse (`/stock-transfers`, transfer-out/transfer-in), so in-transit stock is a queryable balance, not just a status. **Stock adjustment** (`/stock-adjustments` +post) books count-vs-system variance to a GL account. Stock take itself (the physical count capture UI/import) is still schema-only - `stock_adjustments.countedQty` is where a count would land. |
| Recipe | Recipe master, approved versions, costing, modifiers basic, packaging, combo explosion | `/api/recipe/recipes`, `/recipe-versions` (+approve, effective-dated). **Combo and modifier explosion** is a real recursive engine (`src/services/recipeExplosion.ts`, depth-guarded) shared by Consumption and **Production Posting** (`/production-postings` +post - executes Semi-finished/Production BOM recipes, consumes ingredients, produces the output item at computed cost). Recipe costing is branch/warehouse-specific (`/recipe-versions/:id/recompute-cost`). |
| Sales/POS | Excel/API-ready POS import, sales staging, validation, exception queue, sales posting, quote, invoicing, DO, sales return | `/api/sales/sales-import` + `/sales-invoices/:id/post`. **Wholesale cycle** added end to end: `/sales-quotes` (+send, convert-to-invoice), `POST /sales-invoices/wholesale`, `/delivery-orders` (+deliver, posts stock-out/COGS), `/sales-returns` (+post, auto-raises a CustomerCreditNote when the source invoice was already posted). Sale-line modifiers post via `/sales-invoice-lines/:id/modifiers`. |
| Consumption | End-of-day recipe consumption from sales, controlled negative stock, COGS posting | `/api/consumption/generate` - now explodes each sold line through the full recipe/combo/modifier engine (`getEffectiveRecipeVersion` + `explodeRecipeVersion` + `explodeLineModifiers`, merged and netted), not just a flat ingredient list. Missing-recipe / insufficient-stock cases still route to `consumption_exceptions` instead of failing the whole run. |
| Accounting | Payment, receipt, journal voucher, credit note, debit note, contra voucher | Split out as its own module at `/api/accounting/*` (previously lived under Finance): `/customer-receipts` (+post, Invoice/Advance mode, cheque fields), `/journal-entries`, `/credit-notes` and `/debit-notes` (manual, freestanding), `/contra-vouchers` (+post). Vendor Payment (`/procurement/vendor-payments`) stays under Procurement's data model since its posting is tied to purchase-invoice matching, but is the "Payment" voucher an Accounting menu would show. |
| Finance | COA, GL, AP, AR basic, bank/cash, tax, trial balance, P&L, balance sheet | `/api/finance/*` - `/account-groups` + `/chart-of-accounts` (grouped, financial-statement-classified), `/bank-accounts`, `/posting-exceptions`, `/reports/trial-balance` and `/trial-balance-by-group`, **`/reports/profit-and-loss`** and **`/reports/balance-sheet`** (balance-sheet includes a computed retained-earnings line so it actually balances pre-year-end-close), **`/reports/vendor-ledger`** and **`/reports/customer-ledger`** (statement + 30/60/90 aging), **`/cheque-register`** (+status, Bounced auto-reverses the GL posting) and **bank reconciliation** (`/bank-statement-lines` +match/unmatch, `/reports/bank-reconciliation`). |
| Reports | Operational, inventory, sales, purchase, consumption, finance, dashboard reports | Finance reporting (see row above), plus four more report sets this round: **Inventory** (`/inventory/reports/stock-valuation` by item+category, `/reorder-alert` below reorderLevel/minStock with suggested reorder qty, `/slow-moving` stock with no ledger movement in N days), **Sales** (`/sales/reports/sales-summary` by day/branch/channel, `/best-sellers` top+bottom N by revenue, `/channel-mix` POS vs Wholesale split), **Purchase** (`/procurement/reports/vendor-spend`, `/price-variance` GRN unit cost vs PO price by item, `/po-pipeline` open POs with received progress + GRNs pending invoicing), and **Consumption** (`/consumption/reports/variance` - theoretical recipe-driven usage vs shrinkage revealed by posted Stock Adjustments, since there's no independent real-time actual-usage sensor in this data model; see the route's own comment for that reasoning). Every document type also still has its own list/get endpoints with `page`/`pageSize`/basic filters. No dedicated cross-module dashboard endpoint yet - that would roll several of the above into one KPI view. |
| Workflow | Attachments, basic approval workflow, notifications, audit trail | `/api/workflow/document-attachments`, `/approval-workflows` + `/approval-tasks`. **Approval auto-creation is wired**: submitting a Material Request, Purchase Order, Stock Transfer, or Stock Adjustment now creates a Level-1 `ApprovalTask` + `Notification` per user holding that level's role (`src/services/approvalService.ts`), if an Active `ApprovalWorkflow` exists for that moduleCode (one demo two-level workflow is seeded for Material Request). `/approval-tasks/:id/decide` only lets the assigned approver decide, and multi-level chains advance automatically. `/notifications`, `/api/security/audit-logs`. **Audit log auto-write is wired**: `postJournal()` and `postStockMovement()` (the two universal posting choke points - covers GRN, Purchase Invoice, Vendor Payment, Sales Invoice, Consumption, Production Posting, Stock Transfer/Adjustment posting, Contra Voucher, Customer Receipt, Credit/Debit Notes, manual Journal Entries) and `crudFactory.ts`'s create/update/activate/deactivate (covers every master-data screen) now write `audit_logs` rows automatically, plus the submit/approve/decide actions above. |
| SaaS | Tenant master, subdomain login, plan/module entitlement, shared/dedicated DB flag | `/saas/tenants`, `/subscription-plans`, `/tenant-modules`. Subdomain login works when `TENANT_RESOLUTION_MODE=subdomain`; shared/dedicated flag exists on `Tenant.databaseMode` but only shared-DB routing is actually implemented (see `docs/ARCHITECTURE.md`). |

## Still genuinely open within MVP scope

**Approval limits are wired for amount** - `ApprovalWorkflow.conditionJson.minAmount`
is now evaluated in `triggerApproval()` (a demo Purchase Order workflow
requires FinanceManager sign-off only at/above AED 5,000; below that, no
approval task is created at all). Branch/role/variance conditions from the
BRD's "amount/branch/role/variance rules" phrasing are still unevaluated -
only amount is implemented.

**`PostingRule` (the `posting_rules` table) is a different thing than
approval limits** - worth correcting here since an earlier version of this
doc conflated the two. It's meant to be a data-driven GL debit/credit
account *resolution* engine (e.g. "on GRN_POSTED, debit account = X",
configurable per tenant instead of hardcoded), not an approval-amount
gate. It remains completely unused - every posting endpoint still resolves
its GL accounts via hardcoded `resolveCoaByCode()` calls with hardcoded
COA code strings, not by reading `posting_rules`. Wiring it in would mean
rewriting how all ~15 posting endpoints resolve accounts, which is a
genuine architecture change, not a small addition - flagging it honestly
rather than doing it hastily.

Also still open: audit-log coverage for the ~15 other document lifecycle
actions beyond what's listed above (goods return post, sales return post,
RFQ send, consolidation convert, etc. don't write their own audit rows yet
- only their underlying stock/GL postings do, via
postJournal/postStockMovement), sensitive-field masking on custom
(non-CRUD-factory) read endpoints, stock-take capture UI/import, and
operational/dashboard report endpoints beyond Finance.

## Deliberately not started (Phase 2/3 per BRD section 4)

HR/Payroll, Fixed Assets, Central Kitchen production planning (as distinct
from the Production Posting execution step above, which just runs an
already-approved BOM), Quality/Compliance, Maintenance, Projects/Outlet
Opening, Franchise/Multi-Brand/CRM/Loyalty. None of these have Prisma
models, since the ERD blueprint itself scoped its entity list to MVP only.
