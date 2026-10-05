import { PrismaClient } from '../../node_modules/.prisma/client/index.js';
// Tipos gerados pelo Prisma a partir de prisma/schema.prisma — a única fonte
// de verdade do formato de uma linha. Não reintroduza uma interface Payment
// escrita à mão: ela sai de sincronia com o schema em silêncio (typeSafety.test.ts).
export { Prisma } from '../../node_modules/.prisma/client/index.js';
export type { Payment } from '../../node_modules/.prisma/client/index.js';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
