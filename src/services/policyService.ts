import { Prisma, PrismaClient } from "@prisma/client";

type Tx = PrismaClient | Prisma.TransactionClient;

/**
 * Reads a single company_policies value (see prisma/schema.prisma
 * CompanyPolicy and the GET/PUT /api/admin/company-policies endpoints),
 * falling back to defaultValue when nothing's been set yet - so callers
 * never have to special-case "admin hasn't configured this" separately
 * from "admin configured it off/0/false".
 */
export async function getCompanyPolicy<T>(
  tx: Tx,
  params: { tenantId: string; companyId: string; policyKey: string; defaultValue: T }
): Promise<T> {
  const record = await tx.companyPolicy.findUnique({
    where: {
      tenantId_companyId_policyKey: {
        tenantId: params.tenantId,
        companyId: params.companyId,
        policyKey: params.policyKey,
      },
    },
  });
  return record ? (record.policyValue as T) : params.defaultValue;
}
