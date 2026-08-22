import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";

/**
 * One-time (but safe-to-repeat) setup of the Super Admin login used by the
 * frontend's Platform area (tenant list + per-tenant module on/off
 * switches, backed by saas.routes.ts). Runs on every server boot rather
 * than as a separate seed script, since the deploy pipeline only runs
 * `prisma db push` + `npm run build`, never `prisma db seed` - this keeps
 * the Super Admin account provisioned automatically on every deploy with
 * no manual step.
 *
 * Deliberately its own tenant ("platform") rather than reusing a client
 * tenant like "demo" - the Super Admin identity is platform staff, not
 * associated with any one client's data.
 *
 * Everything here is an upsert, so re-running on every restart is a no-op
 * once it's already set up (aside from refreshing the password hash if the
 * env var value ever changes).
 */
export async function ensurePlatformAdmin() {
  const email = process.env.PLATFORM_ADMIN_EMAIL;
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log("[platform-admin] PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD not set - skipping bootstrap.");
    return;
  }

  const tenant = await prisma.tenant.upsert({
    where: { code: "platform" },
    update: {},
    create: {
      code: "platform",
      name: "Platform Administration",
      subdomain: "platform",
      status: "Active",
    },
  });

  const role = await prisma.role.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "SuperAdmin" } },
    update: {},
    create: { tenantId: tenant.id, code: "SuperAdmin", name: "Super Admin" },
  });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email } },
    update: { passwordHash, status: "Active" },
    create: {
      tenantId: tenant.id,
      email,
      displayName: "Platform Admin",
      passwordHash,
      status: "Active",
    },
  });

  await prisma.userRole.upsert({
    where: {
      tenantId_userId_roleId_companyId: {
        tenantId: tenant.id,
        userId: user.id,
        roleId: role.id,
        companyId: null,
      },
    },
    update: {},
    create: { tenantId: tenant.id, userId: user.id, roleId: role.id, companyId: null },
  });

  console.log(`[platform-admin] Ready - log in with tenant code "platform", email ${email}.`);
}
