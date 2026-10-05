import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

/**
 * Logger único e compartilhado por toda a aplicação — usado tanto pelo
 * Fastify (requests HTTP) quanto pelos services de background (Web3Listener,
 * PaymentService, WebhookService, ExpirationWorker), que não têm acesso a um
 * `request`/`app` do Fastify. Consolida nível, formato e saída num só lugar
 * em vez de cada arquivo decidir por conta própria via console.log/warn/error.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  enabled: !isTest,
  // Em produção, saída JSON crua (o que agregadores de log esperam). Em dev,
  // formatação legível via pino-pretty.
  transport:
    !isProduction && !isTest
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        }
      : undefined,
});
