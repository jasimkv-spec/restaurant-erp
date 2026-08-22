import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { crudRouter } from "../../utils/crudFactory";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePermission } from "../../middleware/rbac";
import { ApiError } from "../../utils/errors";

const router = Router();

// --- Users (custom: never expose passwordHash, support invite flow) -------
const userRouter = Router();

userRouter.get(
  "/",
  requirePermission("Security.Users.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const users = await prisma.user.findMany({
      where: { tenantId },
      select: {
        id: true,
        code: true,
        email: true,
        mobile: true,
        displayName: true,
        description: true,
        status: true,
        allowGlobalLogin: true,
        sessionTimeoutMinutes: true,
        managerId: true,
        manager: { select: { id: true, displayName: true, email: true } },
        lastLoginAt: true,
        createdAt: true,
        userRoles: { include: { role: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: users });
  })
);

userRouter.post(
  "/",
  requirePermission("Security.Users.Create"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      code: z.string().optional(),
      email: z.string().email(),
      displayName: z.string().min(1),
      mobile: z.string().optional(),
      description: z.string().optional(),
      password: z.string().min(8),
      linkedEmployeeId: z.string().uuid().optional(),
      allowGlobalLogin: z.boolean().optional(),
      sessionTimeoutMinutes: z.number().int().positive().optional(),
      managerId: z.string().uuid().optional(),
    });
    const payload = schema.parse(req.body);
    const passwordHash = await bcrypt.hash(payload.password, 10);
    const user = await prisma.user.create({
      data: {
        tenantId,
        code: payload.code,
        email: payload.email,
        displayName: payload.displayName,
        mobile: payload.mobile,
        description: payload.description,
        linkedEmployeeId: payload.linkedEmployeeId,
        allowGlobalLogin: payload.allowGlobalLogin,
        sessionTimeoutMinutes: payload.sessionTimeoutMinutes,
        managerId: payload.managerId,
        passwordHash,
        status: "Invited",
      },
    });
    res.status(201).json({ id: user.id, email: user.email, status: user.status });
  })
);

// General field edits (name/contact/preferences/status) - separate from
// password, which only ever changes via the dedicated reset-password route
// below so a stray blank "password" field in an edit form can never
// accidentally wipe someone's login.
userRouter.put(
  "/:id",
  requirePermission("Security.Users.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      code: z.string().optional(),
      email: z.string().email().optional(),
      displayName: z.string().min(1).optional(),
      mobile: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(["Invited", "Active", "Locked", "Inactive"]).optional(),
      allowGlobalLogin: z.boolean().optional(),
      sessionTimeoutMinutes: z.number().int().positive().nullable().optional(),
      managerId: z.string().uuid().nullable().optional(),
    });
    const payload = schema.parse(req.body);
    const existing = await prisma.user.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    if (payload.managerId && payload.managerId === existing.id) {
      throw ApiError.badRequest("A user can't be their own manager.");
    }
    const user = await prisma.user.update({ where: { id: req.params.id }, data: payload });
    res.json({ id: user.id, email: user.email, status: user.status });
  })
);

userRouter.post(
  "/:id/status",
  requirePermission("Security.Users.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ status: z.enum(["Invited", "Active", "Locked", "Inactive"]) });
    const { status } = schema.parse(req.body);
    const existing = await prisma.user.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    const user = await prisma.user.update({ where: { id: req.params.id }, data: { status } });
    res.json({ id: user.id, status: user.status });
  })
);

// CrudTable's generic Enable/Disable button (see CrudTable.tsx's
// handleToggleStatus) always calls .../activate or .../deactivate - these
// give Users the same one-click convenience as every other master screen,
// on top of (not instead of) the full 4-state dropdown via PUT above.
userRouter.post(
  "/:id/activate",
  requirePermission("Security.Users.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.user.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    const user = await prisma.user.update({ where: { id: req.params.id }, data: { status: "Active" } });
    res.json({ id: user.id, status: user.status });
  })
);

userRouter.post(
  "/:id/deactivate",
  requirePermission("Security.Users.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.user.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    const user = await prisma.user.update({ where: { id: req.params.id }, data: { status: "Inactive" } });
    res.json({ id: user.id, status: user.status });
  })
);

userRouter.post(
  "/:id/reset-password",
  requirePermission("Security.Users.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ password: z.string().min(8) });
    const { password } = schema.parse(req.body);
    const existing = await prisma.user.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.user.update({ where: { id: req.params.id }, data: { passwordHash } });
    res.json({ id: existing.id, ok: true });
  })
);

router.use("/users", userRouter);

// --- Roles ------------------------------------------------------------
router.use(
  "/roles",
  crudRouter(prisma.role, {
    permissionKey: "Security.Role",
    createSchema: z.object({
      code: z.string().min(1).max(50),
      name: z.string().min(1),
    }),
  })
);

// --- Permission catalog (global, read-only here) -----------------------
router.get(
  "/permissions",
  requirePermission("Security.Permission.View"),
  asyncHandler(async (req, res) => {
    const permissions = await prisma.permission.findMany({ orderBy: [{ moduleCode: "asc" }, { screenCode: "asc" }] });
    res.json({ data: permissions });
  })
);

// --- Role <-> Permission matrix -----------------------------------------
router.post(
  "/role-permissions",
  requirePermission("Security.RolePermission.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      roleId: z.string().uuid(),
      permissionId: z.string().uuid(),
      allowed: z.boolean().default(true),
    });
    const payload = schema.parse(req.body);
    const record = await prisma.rolePermission.upsert({
      where: { tenantId_roleId_permissionId: { tenantId, roleId: payload.roleId, permissionId: payload.permissionId } },
      update: { allowed: payload.allowed },
      create: { ...payload, tenantId },
    });
    res.json(record);
  })
);

router.get(
  "/roles/:roleId/permissions",
  requirePermission("Security.RolePermission.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const rows = await prisma.rolePermission.findMany({
      where: { tenantId, roleId: req.params.roleId },
      include: { permission: true },
    });
    res.json({ data: rows });
  })
);

// --- User <-> Role assignment -------------------------------------------
router.get(
  "/user-roles",
  requirePermission("Security.UserRole.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const userId = req.query.userId as string | undefined;
    if (!userId) throw ApiError.badRequest("userId query param is required");
    const rows = await prisma.userRole.findMany({
      where: { tenantId, userId },
      include: { role: true },
      orderBy: { id: "asc" },
    });
    res.json({ data: rows });
  })
);

router.post(
  "/user-roles",
  requirePermission("Security.UserRole.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      userId: z.string().uuid(),
      roleId: z.string().uuid(),
      companyId: z.string().uuid().optional(),
      effectiveFrom: z.coerce.date().optional(),
      effectiveTill: z.coerce.date().optional(),
    });
    const payload = schema.parse(req.body);
    const record = await prisma.userRole.create({ data: { ...payload, tenantId } });
    res.status(201).json(record);
  })
);

router.delete(
  "/user-roles/:id",
  requirePermission("Security.UserRole.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.userRole.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    await prisma.userRole.delete({ where: { id: req.params.id } });
    res.status(204).send();
  })
);

// --- Branch / Warehouse access scoping -----------------------------------
router.get(
  "/branch-access",
  requirePermission("Security.BranchAccess.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const userId = req.query.userId as string | undefined;
    if (!userId) throw ApiError.badRequest("userId query param is required");
    const rows = await prisma.userBranchAccess.findMany({
      where: { tenantId, userId },
      include: { branch: { select: { id: true, code: true, name: true, companyId: true } } },
      orderBy: { id: "asc" },
    });
    res.json({ data: rows });
  })
);

router.post(
  "/branch-access",
  requirePermission("Security.BranchAccess.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ userId: z.string().uuid(), branchId: z.string().uuid() });
    const payload = schema.parse(req.body);
    const record = await prisma.userBranchAccess.create({ data: { ...payload, tenantId } });
    res.status(201).json(record);
  })
);

router.delete(
  "/branch-access/:id",
  requirePermission("Security.BranchAccess.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.userBranchAccess.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    await prisma.userBranchAccess.delete({ where: { id: req.params.id } });
    res.status(204).send();
  })
);

router.get(
  "/warehouse-access",
  requirePermission("Security.WarehouseAccess.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const userId = req.query.userId as string | undefined;
    if (!userId) throw ApiError.badRequest("userId query param is required");
    const rows = await prisma.userWarehouseAccess.findMany({
      where: { tenantId, userId },
      include: { warehouse: { select: { id: true, code: true, name: true, branchId: true } } },
      orderBy: { id: "asc" },
    });
    res.json({ data: rows });
  })
);

router.post(
  "/warehouse-access",
  requirePermission("Security.WarehouseAccess.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ userId: z.string().uuid(), warehouseId: z.string().uuid() });
    const payload = schema.parse(req.body);
    const record = await prisma.userWarehouseAccess.create({ data: { ...payload, tenantId } });
    res.status(201).json(record);
  })
);

router.delete(
  "/warehouse-access/:id",
  requirePermission("Security.WarehouseAccess.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.userWarehouseAccess.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    await prisma.userWarehouseAccess.delete({ where: { id: req.params.id } });
    res.status(204).send();
  })
);

// --- Audit log (read-only, append-only source of truth) ------------------
router.get(
  "/audit-logs",
  requirePermission("Security.AuditLog.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50)));
    const where: Record<string, unknown> = { tenantId };
    if (req.query.moduleCode) where.moduleCode = req.query.moduleCode;
    if (req.query.recordId) where.recordId = req.query.recordId;

    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);
    res.json({ data: items, page, pageSize, total });
  })
);

export default router;
