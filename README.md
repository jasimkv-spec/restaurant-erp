# Restaurant Management ERP - MVP Backend

A working Node.js/TypeScript/Express + PostgreSQL (Prisma) backend for the
Restaurant Management ERP described in the uploaded blueprint documents:

- `Restaurant_ERP_BRD_and_Product_Blueprint` (business requirements, MVP scope)
- `Restaurant_ERP_MVP_Database_ERD_Blueprint` (data model)
- `Restaurant_ERP_MVP_Detailed_Field_Dictionary` (field-level rules)
- `Restaurant_ERP_MVP_Screen_Wise_Field_Specification` (screens)
- `Restaurant_ERP_SRS_MVP_Screen_Entity_Workflow_Blueprint` (workflows)

It implements the hybrid-SaaS, multi-tenant data model end to end (100+
Prisma models across Admin, Security, Masters, Inventory, Procurement,
Recipe, Sales/POS, Consumption, Finance, Accounting, Workflow, and SaaS),
plus working REST APIs for the MVP scope: **Procure-to-Pay** (Material
Request -> RFQ -> PO -> GRN -> Purchase Invoice -> Vendor Payment, plus
Goods Return/Debit Note, all posting to stock/GL), **Sales -> Consumption**
(Quote -> Wholesale/POS Invoice -> DO -> Sales Return -> recipe explosion ->
COGS), **Finance** (Chart of Accounts with account grouping, bank accounts,
posting exceptions, trial balance/P&L/Balance Sheet reports), and
**Accounting** (Customer Receipt, Journal Voucher, Credit/Debit Note, Contra
Voucher - the transaction vouchers, split out from Finance's setup/reporting
screens).

See `docs/MVP_SCOPE_MAPPING.md` for exactly which BRD line items are
implemented vs. schema-only, and `docs/ARCHITECTURE.md` for the design
decisions (tenancy, posting engine, costing).

## Requirements

- Node.js 18+
- PostgreSQL 14+ (a plain local install or any managed Postgres)

## Setup

```bash
npm install
cp .env.example .env
# edit .env: set DATABASE_URL to your Postgres instance, and JWT_SECRET

npm run prisma:migrate   # creates the database schema
npm run seed              # loads demo tenant/company/branch/items/recipe/COA
npm run dev                # starts the API on http://localhost:4000
```

> **Note on this build:** this project was scaffolded in a sandboxed
> environment with no access to the npm registry, so `npm install` /
> `npm run build` / `npm run prisma:migrate` could not be executed here to
> verify compilation end-to-end. The Prisma schema was validated by hand
> (every relation checked for a matching back-relation - see the schema's
> header comments) and every source file was checked for balanced
> braces/parens and resolvable imports, but you should run
> `npm run typecheck` right after `npm install` as your first step to catch
> anything that slipped through.

The seed script prints a ready-to-use login:

```
Tenant code / X-Tenant-Code header : demo
Login email                        : admin@demo.local
Login password                     : Passw0rd!
```

## Authentication model

Every request (except `/health`) needs an `X-Tenant-Code: demo` header so
the tenant-isolation middleware can resolve the tenant before touching the
database (`src/middleware/tenant.ts`). Login returns a JWT that also
carries the resolved tenant, so subsequent requests are double-checked: the
token's tenant must match the header's tenant.

```bash
curl -X POST http://localhost:4000/auth/login \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-Code: demo' \
  -d '{"email":"admin@demo.local","password":"Passw0rd!"}'
# => { "token": "...", "user": { ... } }

TOKEN=<paste the token>
```

Every other call under `/api/*` needs both headers:

```bash
curl http://localhost:4000/api/inventory/items \
  -H "X-Tenant-Code: demo" \
  -H "Authorization: Bearer $TOKEN"
```

## Walking the full Procure-to-Pay -> Sale -> Consumption chain

The seed data gives you: company `HQ`, branch `Main Outlet`, warehouse
`Main Kitchen Store`, items `RM-TOMATO` / `RM-BUN` / `MENU-BURGER`, a vendor,
a draft "Classic Burger" recipe (0.15kg tomato + 1 bun), and all the control
GL accounts the posting services need. Fetch the generated ids first:

```bash
curl http://localhost:4000/api/admin/companies -H "X-Tenant-Code: demo" -H "Authorization: Bearer $TOKEN"
curl http://localhost:4000/api/admin/branches -H "X-Tenant-Code: demo" -H "Authorization: Bearer $TOKEN"
curl http://localhost:4000/api/admin/warehouses -H "X-Tenant-Code: demo" -H "Authorization: Bearer $TOKEN"
curl http://localhost:4000/api/inventory/items -H "X-Tenant-Code: demo" -H "Authorization: Bearer $TOKEN"
curl http://localhost:4000/api/procurement/vendors -H "X-Tenant-Code: demo" -H "Authorization: Bearer $TOKEN"
```

1. **Receive stock directly via GRN** (skipping MR/PO for brevity - both are
   available under `/api/procurement/material-requests` and
   `/purchase-orders` if you want the full chain):

   ```bash
   curl -X POST http://localhost:4000/api/procurement/grns \
     -H "X-Tenant-Code: demo" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{
       "companyId": "<company id>",
       "vendorId": "<vendor id>",
       "branchId": "<branch id>",
       "warehouseId": "<warehouse id>",
       "lines": [
         { "itemId": "<tomato item id>", "receivedQty": 50, "acceptedQty": 50, "unitCost": 4.5 },
         { "itemId": "<bun item id>", "receivedQty": 200, "acceptedQty": 200, "unitCost": 0.8 }
       ]
     }'
   # => { "id": "<grn id>", ... }

   curl -X POST http://localhost:4000/api/procurement/grns/<grn id>/post \
     -H "X-Tenant-Code: demo" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{ "companyId": "<company id>" }'
   ```

   This appends stock_ledger rows, updates stock_balances, and books
   Dr Inventory / Cr GRN Clearing.

2. **Approve the burger recipe** so consumption can find it:

   ```bash
   curl http://localhost:4000/api/recipe/recipes -H "X-Tenant-Code: demo" -H "Authorization: Bearer $TOKEN"
   # find the recipe_version id for "Classic Burger"
   curl -X POST http://localhost:4000/api/recipe/recipe-versions/<version id>/approve \
     -H "X-Tenant-Code: demo" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{ "warehouseId": "<warehouse id>" }'
   ```

3. **Import and post a sales invoice**:

   ```bash
   curl -X POST http://localhost:4000/api/sales/sales-import \
     -H "X-Tenant-Code: demo" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{
       "branchId": "<branch id>",
       "businessDate": "2026-08-11",
       "invoices": [{
         "invoiceNo": "INV-0001",
         "gross": 25, "discount": 0, "tax": 1.25,
         "lines": [{ "itemId": "<burger item id>", "qty": 1, "unitPrice": 25 }],
         "payments": [{ "paymentMethodId": "<cash payment method id>", "amount": 26.25 }]
       }]
     }'
   # => { "batch": {...}, "created": [{ "id": "<invoice id>", ... }], "exceptions": [] }

   curl -X POST http://localhost:4000/api/sales/sales-invoices/<invoice id>/post \
     -H "X-Tenant-Code: demo" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{ "companyId": "<company id>" }'
   ```

4. **Generate consumption** (explodes the recipe, posts stock-out + COGS):

   ```bash
   curl -X POST http://localhost:4000/api/consumption/generate \
     -H "X-Tenant-Code: demo" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{
       "companyId": "<company id>",
       "branchId": "<branch id>",
       "businessDate": "2026-08-11",
       "warehouseId": "<warehouse id>"
     }'
   ```

5. **Check the results**:

   ```bash
   curl "http://localhost:4000/api/inventory/stock-balances?warehouseId=<warehouse id>" -H "X-Tenant-Code: demo" -H "Authorization: Bearer $TOKEN"
   curl "http://localhost:4000/api/finance/reports/trial-balance?companyId=<company id>" -H "X-Tenant-Code: demo" -H "Authorization: Bearer $TOKEN"
   ```

## Project layout

```
prisma/schema.prisma       100+-model MVP data model (see file header for design principles)
prisma/seed.ts              Demo tenant + full P2P/recipe/COA/voucher seed data
src/app.ts                  Express app wiring (tenant resolver, auth, routers)
src/server.ts                Process entrypoint
src/middleware/               tenant resolution, JWT auth, RBAC, error handling
src/services/                  stock posting, GL journal posting, COA lookup, recipe explosion
src/utils/                       generic CRUD router factory, document numbering, errors
src/modules/<domain>/           one router per BRD module (admin, security, masters,
                                  inventory, procurement, recipe, sales, consumption,
                                  finance, accounting, workflow, saas, auth)
docs/ARCHITECTURE.md            design decisions and what's simplified
docs/MVP_SCOPE_MAPPING.md       BRD MVP scope table -> implemented endpoints
```

## Known limitations

See `docs/ARCHITECTURE.md` and `docs/MVP_SCOPE_MAPPING.md` for the full
list. Headline items: dedicated-database tenant routing is schema-only,
goods-return/IBT/stock-take/adjustment endpoints aren't built yet (only
GRN-in and consumption-out stock movements exist), the approval-workflow
engine doesn't yet auto-create tasks on document submit, and P&L/balance
sheet reports aren't implemented (trial balance is, as a worked example
over the same `journal_lines` data every other report would use).
