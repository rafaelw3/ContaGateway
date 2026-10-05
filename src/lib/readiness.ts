import { prisma } from './prisma.js';
import { logger } from './logger.js';

export type CheckResult = 'ok' | 'error' | 'timeout' | 'stale';

type ReadinessCheck = () => CheckResult | Promise<CheckResult>;

// Checagens além do banco, registradas por quem sobe os serviços de fundo
// (server.ts registra o Web3Listener). O app.ts não importa esses serviços —
// é o que permite testar rotas sem WSS real (ARCHITECTURE.md §3.3).
const extraChecks = new Map<string, ReadinessCheck>();

export function registerReadinessCheck(name: string, check: ReadinessCheck): void {
  extraChecks.set(name, check);
}

/** Só para testes: volta ao estado de um app sem serviços de fundo. */
export function clearReadinessChecks(): void {
  extraChecks.clear();
}

/**
 * Roda o banco e toda checagem registrada. Uma checagem que lança vira
 * 'error' — nunca derruba a rota nem vaza a mensagem.
 */
export async function runReadinessChecks(): Promise<Record<string, CheckResult>> {
  const results: Record<string, CheckResult> = { database: await checkDatabase() };
  for (const [name, check] of extraChecks) {
    try {
      results[name] = await check();
    } catch (err) {
      logger.error({ err }, `[readiness] Checagem "${name}" falhou`);
      results[name] = 'error';
    }
  }
  return results;
}

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Verifica se o Postgres responde a um `SELECT 1` dentro do prazo. Com prazo
 * porque um banco travado (conexão pendurada, pool esgotado) não rejeita — só
 * nunca responde, e um health check sem prazo ficaria pendurado junto.
 *
 * Nunca lança: devolve o resultado e loga o erro real. Quem chama (rota
 * pública) só expõe `ok`/`error`/`timeout`, nunca a mensagem do Prisma, que
 * pode trazer host e usuário do banco.
 */
export async function checkDatabase(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    const result = await Promise.race([prisma.$queryRaw`SELECT 1`.then(() => 'ok' as const), timeout]);
    if (result === 'timeout') {
      logger.warn(`[readiness] Banco não respondeu em ${timeoutMs}ms`);
    }
    return result;
  } catch (err) {
    logger.error({ err }, '[readiness] Falha ao consultar o banco');
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}
