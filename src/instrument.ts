// Deve ser carregado antes de qualquer outro módulo (via node --import) para
// que a auto-instrumentação do OpenTelemetry consiga interceptar http, pg,
// fetch etc. antes de serem usados. Ver ARCHITECTURE.md / package.json scripts.
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
  // 100% em dev, 10% em produção — suficiente para diagnosticar sem gerar volume desnecessário.
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  // Correlaciona os logs estruturados do pino (src/lib/logger.ts) com erros e traces no Sentry.
  enableLogs: true,
  includeLocalVariables: true,
  ignoreTransactions: ['GET /health'],
});
