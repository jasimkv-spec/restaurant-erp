import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/asyncHandler";
import { ApiError } from "../../utils/errors";
import { requireTenant } from "../../middleware/tenant";

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1),
  mobile: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

/**
 * POST /auth/register
 * Creates a user in "Invited" status (per Statuses & Actions reference:
 * User Statuses = Invited; Active; Locked; Inactive). In a real deployment
 * this would be gated behind Tenant Admin invite + email verification;
 * exposed directly here for MVP/demo bootstrapping.
 */
router.post(
  "/register",
  requireTenant,
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const payload = registerSchema.parse(req.body);

    const existing = await prisma.user.findFirst({
      where: { tenantId, email: payload.email },
    });
    if (existing) throw ApiError.conflict("Email already registered for this tenant");

    const passwordHash = await bcrypt.hash(payload.password, 10);
    const user = await prisma.user.create({
      data: {
        tenantId,
        email: payload.email,
        displayName: payload.displayName,
        mobile: payload.mobile,
        passwordHash,
        status: "Active", // MVP: auto-activate; swap to "Invited" once email verification exists
      },
    });

    res.status(201).json({ id: user.id, email: user.email, status: user.status });
  })
);

/**
 * POST /auth/login
 * Returns a JWT embedding the user's role codes and flattened
 * "module.screen.action" permission strings (see middleware/rbac.ts).
 */
router.post(
  "/login",
  requireTenant,
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findFirst({ where: { tenantId, email } });
    if (!user) throw ApiError.unauthorized("Invalid credentials");
    if (user.status !== "Active") throw ApiError.forbidden(`User is ${user.status.toLowerCase()}`);

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw ApiError.unauthorized("Invalid credentials");

    const userRoles = await prisma.userRole.findMany({
      where: { tenantId, userId: user.id },
      include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
    });

    const roles = [...new Set(userRoles.map((ur) => ur.role.code))];
    const permissions = [
      ...new Set(
        userRoles.flatMap((ur) =>
          ur.role.rolePermissions
            .filter((rp) => rp.allowed)
            .map((rp) => `${rp.permission.moduleCode}.${rp.permission.screenCode}.${rp.permission.actionCode}`)
        )
      ),
    ];

    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET is not configured");

    const token = jwt.sign(
      { userId: user.id, tenantId, email: user.email, roles, permissions },
      secret,
      { expiresIn: (process.env.JWT_EXPIRES_IN as any) ?? "8h" }
    );

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    // Branch scoping for document screens (e.g. Material Request's "auto-
    // select the user's branch"): UserBranchAccess rows are an explicit
    // allow-list. No rows at all means the user was never restricted (most
    // admin/head-office users), so they see every active branch instead of
    // being locked out entirely.
    const branchAccess = await prisma.userBranchAccess.findMany({
      where: { tenantId, userId: user.id },
      select: { branch: { select: { id: true, code: true, name: true } } },
    });
    const branches = branchAccess.length
      ? branchAccess.map((b) => b.branch)
      : await prisma.branch.findMany({
          where: { tenantId, status: "Active" },
          select: { id: true, code: true, name: true },
          orderBy: { code: "asc" },
        });

    res.json({ token, user: { id: user.id, email: user.email, displayName: user.displayName, roles, branches } });
  })
);

export default router;
