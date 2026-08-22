import { Request } from "express";
import { Prisma, PrismaClient } from "@prisma/client";
import { hasPermission } from "../middleware/rbac";
import { ApiError } from "../utils/errors";

type Tx = PrismaClient | Prisma.TransactionClient;

interface ApprovalLevel {
  level: number;
  approverRoleCode: string;
}

interface WorkflowCondition {
  minAmount?: number;
}

function parseCondition(json: unknown): WorkflowCondition {
  if (typeof json !== "object" || json === null) return {};
  const minAmount = (json as any).minAmount;
  return typeof minAmount === "number" ? { minAmount } : {};
}

function parseLevels(json: unknown): ApprovalLevel[] {
  if (!Array.isArray(json)) return [];
  return json.filter(
    (l): l is ApprovalLevel =>
      typeof l === "object" && l !== null && typeof (l as any).level === "number" && typeof (l as any).approverRoleCode === "string"
  );
}

async function createLevelTasks(tx: Tx, tenantId: string, workflowId: string, recordId: string, levels: ApprovalLevel[], level: number) {
  const roleCodes = levels.filter((l) => l.level === level).map((l) => l.approverRoleCode);
  if (roleCodes.length === 0) return [];

  const approvers = await tx.userRole.findMany({
    where: { tenantId, role: { code: { in: roleCodes } }, user: { status: "Active" } },
    distinct: ["userId"],
  });

  const tasks: any[] = [];
  for (const a of approvers) {
    const task = await tx.approvalTask.create({
      data: { tenantId, workflowId, recordId, level, approverUserId: a.userId, status: "Pending" },
    });
    await tx.notification.create({
      data: {
        tenantId,
        userId: a.userId,
        title: "Approval needed",
        body: `A document (record ${recordId}) is waiting on your approval at level ${level}.`,
      },
    });
    tasks.push(task);
  }
  return tasks;
}

/**
 * Called when a document is submitted (BRD "basic approval workflow"). If
 * an Active ApprovalWorkflow exists for moduleCode, creates one
 * ApprovalTask + Notification per Active user holding the first level's
 * role. No-op (returns []) if no workflow is configured for that module -
 * submission proceeds exactly as it did before this existed, for any
 * tenant that hasn't set one up.
 *
 * moduleCode should match the permission-key module namespace of the
 * document (e.g. "Procurement.MaterialRequest") - that's what the seeded
 * demo workflow and any tenant-configured one key off.
 *
 * If the workflow's conditionJson has a minAmount and the caller passes
 * amount, the whole workflow is skipped (no tasks, no-op) when amount is
 * below it - the "approval limit" BRD 5.1's condition_json column was
 * meant for (small documents don't need sign-off; larger ones do). Callers
 * that don't have a natural single amount (e.g. Material Request, which is
 * quantity- not price-based pre-costing) simply omit amount and any
 * minAmount condition is ignored - the workflow always applies to them.
 */
export async function triggerApproval(tx: Tx, params: { tenantId: string; moduleCode: string; recordId: string; amount?: number }) {
  const workflow = await tx.approvalWorkflow.findFirst({
    where: { tenantId: params.tenantId, moduleCode: params.moduleCode, status: "Active" },
  });
  if (!workflow) return [];

  const condition = parseCondition(workflow.conditionJson);
  if (condition.minAmount !== undefined && params.amount !== undefined && params.amount < condition.minAmount) {
    return [];
  }

  const levels = parseLevels(workflow.approvalLevelsJson);
  if (levels.length === 0) return [];
  const firstLevel = Math.min(...levels.map((l) => l.level));

  return createLevelTasks(tx, params.tenantId, workflow.id, params.recordId, levels, firstLevel);
}

/**
 * Called from POST /workflow/approval-tasks/:id/decide right after the
 * task's own status has been set to Approved or Rejected. Either way,
 * skips any other still-Pending sibling task at the same level
 * (first-approver-wins per level, not unanimous). On Approved, creates
 * the next level's tasks if there is one; if this was the last level,
 * returns fullyApproved: true so the caller can decide what that means
 * for the underlying document (this service only tracks the approval
 * chain itself, not each module's document lifecycle/status field).
 */
export async function advanceApproval(
  tx: Tx,
  task: { id: string; tenantId: string; workflowId: string; recordId: string; level: number; status: string }
) {
  await tx.approvalTask.updateMany({
    where: {
      tenantId: task.tenantId,
      workflowId: task.workflowId,
      recordId: task.recordId,
      level: task.level,
      status: "Pending",
      id: { not: task.id },
    },
    data: { status: "Skipped", actedAt: new Date() },
  });

  if (task.status !== "Approved") return { fullyApproved: false };

  const workflow = await tx.approvalWorkflow.findFirst({ where: { id: task.workflowId, tenantId: task.tenantId } });
  if (!workflow) return { fullyApproved: false };

  const levels = parseLevels(workflow.approvalLevelsJson);
  const nextLevel = levels
    .map((l) => l.level)
    .filter((l) => l > task.level)
    .sort((a, b) => a - b)[0];
  if (nextLevel === undefined) return { fullyApproved: true };

  await createLevelTasks(tx, task.tenantId, workflow.id, task.recordId, levels, nextLevel);
  return { fullyApproved: false };
}

/**
 * The single approval-authority rule used by every document's own
 * `/:id/approve` route (Material Request, Purchase Order, and future GRN).
 * This is deliberately separate from the ApprovalWorkflow/ApprovalTask
 * chain above (that engine tracks a parallel notification/sign-off record;
 * it doesn't gate the document's own status field).
 *
 * A caller may approve a document if either is true:
 *   1. They hold the module's own Approve permission (e.g.
 *      "Procurement.MaterialRequest.Approve") via their role - this is the
 *      existing, unchanged rule and by itself already covers a person
 *      approving their own document or their team's, as long as their role
 *      carries that permission.
 *   2. They are the specific requester's line manager (User.managerId),
 *      even if the manager's own role does not carry the Approve
 *      permission - lets a plain "Staff" role's manager sign off on their
 *      direct reports' documents without needing a broader approver role.
 *
 * requesterUserId may be null/undefined for legacy records created before
 * requester/createdBy tracking existed - in that case only rule 1 applies,
 * matching today's actual behaviour for those records.
 */
export async function assertCanApprove(
  tx: Tx,
  req: Request,
  params: { tenantId: string; requesterUserId?: string | null; permission: string }
) {
  if (hasPermission(req, params.permission)) return;

  if (params.requesterUserId && req.user) {
    const requester = await tx.user.findFirst({
      where: { id: params.requesterUserId, tenantId: params.tenantId },
      select: { managerId: true },
    });
    if (requester?.managerId && requester.managerId === req.user.userId) return;
  }

  throw ApiError.forbidden(`Missing permission: ${params.permission}`);
}
