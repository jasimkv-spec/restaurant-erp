import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { crudRouter } from "../../utils/crudFactory";
import { asyncHandler } from "../../utils/asyncHandler";
import { requirePermission } from "../../middleware/rbac";
import { ApiError } from "../../utils/errors";
import { advanceApproval } from "../../services/approvalService";
import { writeAuditLog } from "../../services/auditService";

const router = Router();

// Memory storage (no local disk writes - Render's free-tier disk is
// ephemeral) - the file lands in req.file.buffer and gets copied straight
// into the fileData Bytes column below. 10MB cap keeps a single upload from
// ballooning the request past what the JSON-body-sized infra elsewhere
// expects.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// --- Document Types -----------------------------------------------------------
router.use(
  "/document-types",
  crudRouter(prisma.documentType, {
    permissionKey: "Workflow.DocumentType",
    createSchema: z.object({
      moduleCode: z.string().min(1),
      name: z.string().min(1),
      expiryRequired: z.boolean().default(false),
      verificationRequired: z.boolean().default(false),
      mandatory: z.boolean().default(false),
    }),
    statusField: "name",
  })
);

// --- Document Attachments (polymorphic: moduleCode + recordId) --------------
// Reused as-is for masters today (Vendor/Customer, Employee later) and for
// transaction-level attachments in future - callers just pass a different
// moduleCode/recordId, no schema or route changes needed for that.
router.post(
  "/document-attachments",
  requirePermission("Workflow.DocumentAttachment.Create"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({
      moduleCode: z.string().min(1),
      recordId: z.string().min(1),
      documentTypeId: z.string().uuid(),
      fileRef: z.string().min(1).optional(),
      issueDate: z.coerce.date().optional(),
      expiryDate: z.coerce.date().optional(),
    });
    const payload = schema.parse(req.body);
    const file = req.file;
    if (!file && !payload.fileRef) {
      throw ApiError.badRequest("A file upload (or fileRef) is required.");
    }
    const record = await prisma.documentAttachment.create({
      data: {
        ...payload,
        fileRef: payload.fileRef ?? file!.originalname,
        fileName: file?.originalname,
        mimeType: file?.mimetype,
        fileData: file?.buffer,
        tenantId,
      },
      select: {
        id: true,
        tenantId: true,
        moduleCode: true,
        recordId: true,
        documentTypeId: true,
        fileRef: true,
        fileName: true,
        mimeType: true,
        issueDate: true,
        expiryDate: true,
        status: true,
        createdAt: true,
      },
    });
    res.status(201).json(record);
  })
);

router.get(
  "/document-attachments",
  requirePermission("Workflow.DocumentAttachment.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ moduleCode: z.string(), recordId: z.string() });
    const { moduleCode, recordId } = schema.parse(req.query);
    // fileData (raw bytes) is deliberately excluded here - the list view
    // only needs metadata; actual bytes are streamed on demand from the
    // /download endpoint below so this list stays fast and small.
    const items = await prisma.documentAttachment.findMany({
      where: { tenantId, moduleCode, recordId },
      select: {
        id: true,
        tenantId: true,
        moduleCode: true,
        recordId: true,
        documentTypeId: true,
        documentType: true,
        fileRef: true,
        fileName: true,
        mimeType: true,
        issueDate: true,
        expiryDate: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: items });
  })
);

router.get(
  "/document-attachments/:id/download",
  requirePermission("Workflow.DocumentAttachment.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const record = await prisma.documentAttachment.findFirst({ where: { id: req.params.id, tenantId } });
    if (!record) throw ApiError.notFound();
    if (!record.fileData) {
      throw ApiError.badRequest("This attachment has no stored file to download (legacy fileRef-only row).");
    }
    res.setHeader("Content-Type", record.mimeType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${(record.fileName || record.fileRef).replace(/"/g, "")}"`
    );
    res.send(Buffer.from(record.fileData));
  })
);

router.delete(
  "/document-attachments/:id",
  requirePermission("Workflow.DocumentAttachment.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.documentAttachment.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    await prisma.documentAttachment.delete({ where: { id: existing.id } });
    res.status(204).send();
  })
);

// --- Approval Workflows -----------------------------------------------------------
router.use(
  "/approval-workflows",
  crudRouter(prisma.approvalWorkflow, {
    permissionKey: "Workflow.ApprovalWorkflow",
    createSchema: z.object({
      moduleCode: z.string().min(1),
      conditionJson: z.record(z.any()).default({}),
      approvalLevelsJson: z.array(z.any()).default([]),
    }),
    statusField: "moduleCode",
  })
);

// --- Approval Tasks -----------------------------------------------------------
router.get(
  "/approval-tasks",
  requirePermission("Workflow.ApprovalTask.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const where: Record<string, unknown> = { tenantId };
    if (req.user) where.approverUserId = req.user.userId;
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.approvalTask.findMany({ where, orderBy: { createdAt: "desc" } });
    res.json({ data: items });
  })
);

/**
 * Decides a single approval task. Only that task's own approverUserId may
 * decide it (TenantAdmin bypasses via requirePermission's own rules) -
 * having the Approve permission grants the *ability* to be assigned tasks,
 * not the ability to decide someone else's. On Approved/Rejected,
 * advanceApproval() skips any other Pending sibling at the same level and,
 * if approved, opens the next level (or reports fullyApproved so the
 * caller/UI knows the chain is done - this endpoint does not itself flip
 * the source document's status, since that stays owned by each module's
 * own /approve action).
 */
router.post(
  "/approval-tasks/:id/decide",
  requirePermission("Workflow.ApprovalTask.Approve"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const schema = z.object({ decision: z.enum(["Approved", "Rejected"]) });
    const { decision } = schema.parse(req.body);
    const existing = await prisma.approvalTask.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    if (existing.status !== "Pending") throw ApiError.badRequest(`Task already ${existing.status}`);
    if (req.user && req.user.userId !== existing.approverUserId) {
      throw ApiError.forbidden("Only the assigned approver can decide this task");
    }

    const { fullyApproved } = await prisma.$transaction(async (tx) => {
      await tx.approvalTask.update({ where: { id: existing.id }, data: { status: decision, actedAt: new Date() } });
      return advanceApproval(tx, { ...existing, status: decision });
    });

    const record = await prisma.approvalTask.findUnique({ where: { id: existing.id } });
    await writeAuditLog(prisma, {
      tenantId,
      userId: req.user?.userId,
      moduleCode: "Workflow.ApprovalTask",
      recordTable: "approval_tasks",
      recordId: existing.id,
      action: decision,
    });
    res.json({ ...record, fullyApproved });
  })
);

// --- Notifications -----------------------------------------------------------
router.get(
  "/notifications",
  requirePermission("Workflow.Notification.View"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const userId = req.user!.userId;
    const items = await prisma.notification.findMany({
      where: { tenantId, userId },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: items });
  })
);

router.post(
  "/notifications/:id/read",
  requirePermission("Workflow.Notification.Edit"),
  asyncHandler(async (req, res) => {
    const tenantId = req.tenant!.id;
    const existing = await prisma.notification.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw ApiError.notFound();
    const record = await prisma.notification.update({ where: { id: existing.id }, data: { status: "Read" } });
    res.json(record);
  })
);

export default router;
