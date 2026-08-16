import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import { tenantResolver, requireTenant } from "./middleware/tenant";
import { requireAuth } from "./middleware/auth";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

import authRoutes from "./modules/auth/auth.routes";
import saasRoutes from "./modules/saas/saas.routes";
import adminRoutes from "./modules/admin/admin.routes";
import securityRoutes from "./modules/security/security.routes";
import mastersRoutes from "./modules/masters/masters.routes";
import inventoryRoutes from "./modules/inventory/inventory.routes";
import procurementRoutes from "./modules/procurement/procurement.routes";
import recipeRoutes from "./modules/recipe/recipe.routes";
import salesRoutes from "./modules/sales/sales.routes";
import consumptionRoutes from "./modules/consumption/consumption.routes";
import financeRoutes from "./modules/finance/finance.routes";
import accountingRoutes from "./modules/accounting/accounting.routes";
import workflowRoutes from "./modules/workflow/workflow.routes";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "5mb" }));
  if (process.env.NODE_ENV !== "test") {
    app.use(morgan("dev"));
  }

  app.get("/health", (req, res) => res.json({ status: "ok", service: "restaurant-erp-mvp" }));

  // Resolve tenant context (X-Tenant-Code header or subdomain) for every
  // request before any business route runs - ERD blueprint section 11.
  app.use(tenantResolver);

  // Platform-level SaaS administration is intentionally outside tenant scope.
  app.use("/saas", saasRoutes);

  // Auth needs a tenant to look the user up in, but not yet a JWT.
  app.use("/auth", authRoutes);

  // Everything else requires both a resolved tenant AND a valid JWT whose
  // tenant matches (see middleware/auth.ts).
  const api = express.Router();
  api.use(requireTenant, requireAuth);
  api.use("/admin", adminRoutes);
  api.use("/security", securityRoutes);
  api.use("/masters", mastersRoutes);
  api.use("/inventory", inventoryRoutes);
  api.use("/procurement", procurementRoutes);
  api.use("/recipe", recipeRoutes);
  api.use("/sales", salesRoutes);
  api.use("/consumption", consumptionRoutes);
  api.use("/finance", financeRoutes);
  api.use("/accounting", accountingRoutes);
  api.use("/workflow", workflowRoutes);
  app.use("/api", api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
