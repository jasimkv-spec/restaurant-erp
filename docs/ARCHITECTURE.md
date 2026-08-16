# Architecture Notes

This backend implements the MVP scope from `Restaurant_ERP_BRD_and_Product_Blueprint`,
`Restaurant_ERP_MVP_Database_ERD_Blueprint`, `Restaurant_ERP_MVP_Detailed_Field_Dictionary`,
and `Restaurant_ERP_MVP_Screen_Wise_Field_Specification`. See `MVP_SCOPE_MAPPING.md` for
a module-by-module trace back to those documents.

## Stack

- **Runtime**: Node.js + TypeScript, Express
- **Database**: PostgreSQL via Prisma ORM (`prisma/schema.prisma`)
- **Auth**: JWT (roles + flattened permission strings embedded at login)

## Tenant model

The BRD calls for a hybrid SaaS model: shared database with `tenant_id` for
small clients, dedicated database (same schema/code) for enterprise clients.

This codebase implements the **shared-database** side fully. Every
tenant-owned Prisma model carries `tenantId`, and `src/middleware/tenant.ts`
resolves the tenant (via `X-Tenant-Code` header, or subdomain when
`TENANT_RESOLUTION_MODE=subdomain`) before any business route runs. All
queries in `src/modules/**` are filtered by `req.tenant.id` - there is no
implicit global scope.

**Dedicated-database routing is stubbed, not implemented.** The
`tenant_database_connections` table and `Tenant.databaseMode` field exist so
the data model matches the blueprint, but there is no connection-pool router
that would open a different Postgres connection per dedicated tenant. Adding
one means: (1) look up `tenant_database_connections` for the resolved tenant,
(2) if `mode = Dedicated`, obtain/construct a `PrismaClient` bound to that
tenant's connection string (from an encrypted secret store, never the
database itself) instead of the shared singleton in `src/lib/prisma.ts`, and
(3) cache those clients per tenant. This is Phase-2/3 work per the BRD's own
roadmap (section 4) and was intentionally left out of the MVP.

## Posting engine (simplified)

The blueprint describes a full posting-rule engine (`posting_rules` table,
per-module/event debit/credit resolution). The MVP ships the `posting_rules`
table in the schema but the actual services
(`src/services/journalService.ts`, `src/services/stockService.ts`,
`src/services/coaLookup.ts`) hard-code which control accounts each workflow
posts to (by seeded Chart of Accounts codes like `INVENTORY-CONTROL`,
`GRN-CLEARING`, `AP-CONTROL`, `COGS-CONTROL`, `REVENUE-CONTROL`,
`SALES-CLEARING`, `TAX-OUTPUT`, `CASH-CONTROL`). This keeps the demo
transaction chain (PO -> GRN -> Invoice -> Payment, Sales -> Consumption)
fully working without requiring a rule-configuration UI first. Swapping in a
real posting-rule lookup (reading `posting_rules` instead of a fixed code)
is a contained change inside those three service files.

If a required control account isn't found for a company, the posting
service does **not** fail the whole request - it writes a row to
`posting_exceptions` (or `consumption_exceptions`) and lets the source
document continue (e.g. GRN still moves stock even if the GL side has no
account configured yet), matching the BRD's exception-queue design
principle (section 10.1, ERD blueprint section 12).

## Stock costing

`src/services/stockService.ts` implements weighted-average costing (the
MVP default per BRD 5.5): every inbound movement recomputes
`stock_balances.value` and every outbound movement is costed at the
balance's average cost immediately before the movement. `stock_ledger` is
append-only; `stock_balances` is a materialized projection that can be
rebuilt by replaying the ledger (per ERD blueprint section 12).

## What's deliberately out of scope for this pass

Per the BRD's own phase roadmap (section 4), these are Phase 2/3 and are
represented only as far as the ERD blueprint requires (i.e. not at all,
since the ERD blueprint itself scopes to MVP tables):

- HR/Payroll, Fixed Assets, Central Kitchen production orders, Quality/QC
  logs, Maintenance, Projects/Outlet opening, Franchise/CRM/Loyalty.
- Dedicated-DB connection routing (see above).
- A configurable approval-workflow *engine* - `approval_workflows` /
  `approval_tasks` tables and basic CRUD exist, but nothing currently
  auto-creates approval tasks when a document is submitted. Wiring that in
  is a matter of calling into `ApprovalWorkflow`/`ApprovalTask` from the
  `submit` handlers in `procurement.routes.ts` once workflow condition
  matching is needed.
- Background/queued jobs (imports, alerts, settlement matching) - the
  MVP's sales import and consumption generation run synchronously in the
  request; move them to a queue (BullMQ, etc.) before real POS volumes.
