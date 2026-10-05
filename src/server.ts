import 'dotenv/config';
import * as Sentry from '@sentry/node';
import { buildApp } from './app.js';
import { web3Listener } from './services/Web3Listener.js';
import { expirationWorker } from './services/ExpirationWorker.js';
import { webhookService } from './services/WebhookService.js';
import { registerReadinessCheck } from './lib/readiness.js';
import { prisma } from './lib/prisma.js';
import { logger } from './lib/logger.js';
import { assertRequiredEnv } from './lib/envValidation.js';

assertRequiredEnv();

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

let app: Awaited<ReturnType<typeof buildApp>>;

async function bootstrap() {
  try {
    app = await buildApp();

    // Inicia o servidor HTTP Fastify
    await app.listen({ port, host });
    logger.info(`🚀 [ContaGateway] Servidor HTTP ouvindo em http://${host}:${port}`);

    // Antes de liquidar qualquer coisa nova: entregas de webhook que o
    // processo anterior deixou no meio viram FAILED (reenvio manual).
    await webhookService.markInterruptedDeliveriesAsFailed();

    // Inicia o Oráculo Web3 (Base / BRLA)
    web3Listener.start();
    registerReadinessCheck('web3', () => web3Listener.getHealth());

    // Inicia o Worker Periódico de Expiração de Cobranças
    expirationWorker.start();
  } catch (err) {
    logger.error({ err }, '[ContaGateway] Falha ao iniciar o servidor');
    process.exit(1);
  }
}

// Encerramento gracioso
const shutdown = async (signal: string) => {
  logger.info(`Recebido sinal de encerramento (${signal}). Fechando recursos...`);
  web3Listener.stop();
  expirationWorker.stop();
  await app?.close();
  await prisma.$disconnect();
  await Sentry.flush(2000);
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, '[ContaGateway] Unhandled Rejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, '[ContaGateway] Uncaught Exception');
});

bootstrap();
