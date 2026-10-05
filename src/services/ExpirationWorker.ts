import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export class ExpirationWorker {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private isProcessing = false;

  constructor() {
    this.intervalMs = Number(process.env.EXPIRATION_WORKER_INTERVAL_MS) || 60000;
  }

  /**
   * Inicia o worker periódico de expiração
   */
  start(): void {
    if (this.timer) return;

    logger.info(`[ExpirationWorker] 🕒 Worker de expiração ativo (intervalo: ${this.intervalMs / 1000}s)...`);

    // Executa uma primeira checagem imediata na inicialização
    void this.checkAndExpirePayments();

    this.timer = setInterval(() => {
      void this.checkAndExpirePayments();
    }, this.intervalMs);
  }

  /**
   * Encerra o worker de expiração
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[ExpirationWorker] Worker de expiração encerrado.');
    }
  }

  /**
   * Executa a varredura e expira pagamentos PENDING que ultrapassaram a data limite
   */
  async checkAndExpirePayments(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    try {
      const now = new Date();
      const result = await prisma.payment.updateMany({
        where: {
          status: 'PENDING',
          expiresAt: { lt: now },
        },
        data: {
          status: 'EXPIRED',
        },
      });

      if (result.count > 0) {
        logger.info(
          `[ExpirationWorker] ⌛ ${result.count} cobrança(s) PENDING expirada(s) atualizada(s) para EXPIRED.`
        );
      }

      return result.count;
    } catch (error) {
      logger.error({ err: error }, '[ExpirationWorker] Erro ao verificar pagamentos expirados');
      return 0;
    } finally {
      this.isProcessing = false;
    }
  }
}

export const expirationWorker = new ExpirationWorker();
