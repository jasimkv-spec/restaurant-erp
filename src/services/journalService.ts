import { Prisma, PrismaClient } from "@prisma/client";
import { assertPeriodOpen } from "./periodService";
import { writeAuditLog } from "./auditService";

type Tx = PrismaClient | Prisma.TransactionClient;

export interface JournalLineInput {
  accountId: string;
  debit?: number;
  credit?: number;
  branchId?: string | null;
  costCentreId?: string | null;
  profitCentreId?: string | null;
}

export interface PostJournalInput {
  tenantId: string;
  companyId: string;
  sourceModule: string; // Procurement|Sales|Consumption|Payroll|Assets|Manual
  sourceDocId?: string;
  journalDate?: Date;
  postedBy?: string;
  lines: JournalLineInput[];
}

/**
 * Posts a balanced GL journal, per ERD blueprint section 12: "Source
 * transaction -> accounting event -> posting rules -> journal preview ->
 * journal entry." Journals are append-only once Posted (BRD 10.1: posted
 * transactions must not be edited directly).
 *
 * Throws if the journal does not balance (sum debit != sum credit) -
 * callers should validate/short-circuit before calling this, or route the
 * failure to posting_exceptions instead of calling postJournal at all.
 */
export async function postJournal(tx: Tx, input: PostJournalInput) {
  const totalDebit = input.lines.reduce((sum, l) => sum + (l.debit ?? 0), 0);
  const totalCredit = input.lines.reduce((sum, l) => sum + (l.credit ?? 0), 0);

  if (Math.abs(totalDebit - totalCredit) > 0.001) {
    throw new Error(
      `Unbalanced journal: total debit ${totalDebit} != total credit ${totalCredit}`
    );
  }
  if (input.lines.length === 0) {
    throw new Error("Journal must have at least one line");
  }

  const journalDate = input.journalDate ?? new Date();
  await assertPeriodOpen(tx, {
    tenantId: input.tenantId,
    companyId: input.companyId,
    date: journalDate,
    kind: "Finance",
  });

  const journal = await tx.journalEntry.create({
    data: {
      tenantId: input.tenantId,
      companyId: input.companyId,
      sourceModule: input.sourceModule,
      sourceDocId: input.sourceDocId,
      journalDate,
      status: "Posted",
      postedBy: input.postedBy,
      postedAt: new Date(),
      lines: {
        create: input.lines.map((l) => ({
          tenantId: input.tenantId,
          accountId: l.accountId,
          debit: l.debit ?? 0,
          credit: l.credit ?? 0,
          branchId: l.branchId ?? undefined,
          costCentreId: l.costCentreId ?? undefined,
          profitCentreId: l.profitCentreId ?? undefined,
        })),
      },
    },
    include: { lines: true },
  });

  await writeAuditLog(tx, {
    tenantId: input.tenantId,
    userId: input.postedBy,
    moduleCode: input.sourceModule,
    recordTable: "journal_entries",
    recordId: journal.id,
    action: "Posted",
    newValue: { sourceDocId: input.sourceDocId, journalDate, lines: input.lines },
  });

  return journal;
}

/** Records a posting exception instead of throwing, so the source document
 * can move to an "Exception" status and be corrected/reprocessed later
 * (BRD 10.1 / ERD blueprint 12: "Exception handling"). */
export async function recordPostingException(
  tx: Tx,
  params: {
    tenantId: string;
    sourceModule: string;
    sourceDocId?: string;
    exceptionType: string;
    message: string;
  }
) {
  return tx.postingException.create({
    data: {
      tenantId: params.tenantId,
      sourceModule: params.sourceModule,
      sourceDocId: params.sourceDocId,
      exceptionType: params.exceptionType,
      message: params.message,
    },
  });
}
