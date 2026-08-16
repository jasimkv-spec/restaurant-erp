import { PrismaClient } from "@prisma/client";

// Single shared Prisma client instance for the whole process.
// In a dedicated-DB tenant deployment, this would be swapped out per-request
// by a connection-routing layer (see docs/ARCHITECTURE.md).
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

export default prisma;
