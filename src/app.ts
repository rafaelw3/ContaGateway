import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import * as Sentry from '@sentry/node';
import { paymentRoutes } from './routes/routes.js';
import { logger } from './lib/logger.js';
import { createRedisClient } from './lib/rateLimitStore.js';
import { runReadinessChecks } from './lib/readiness.js';
import { apiKeyMatches, parseApiKeys } from './lib/apiKeys.js';

// Controla se X-Forwarded-Proto/Host/For são confiados para montar
// request.protocol/hostname/ip. Sem isso, esses cabeçalhos são ignorados por
// padrão (seguro mesmo se a app ficar diretamente exposta) — só habilite se
// o deploy realmente tiver um proxy reverso confiável na frente.
//   TRUST_PROXY=true                 -> confia em qualquer proxy (só use se
//                                        souber que todo tráfego passa por ele)
//   TRUST_PROXY=10.0.0.0/8,1.2.3.4   -> confia só nesses IPs/CIDRs
//   ausente / qualquer outro valor   -> não confia em nada (padrão)
function resolveTrustProxy(): boolean | string[] {
  const raw = process.env.TRUST_PROXY;
  if (!raw) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

const PAY_ROUTE_REGEX = /^\/pay\/[^/]+$/;
const QRCODE_ROUTE_REGEX = /^\/v1\/payments\/[^/]+\/qrcode$/;
const STATUS_ROUTE_REGEX = /^\/v1\/payments\/[^/]+\/status$/;

/**
 * Monta a aplicação HTTP (rotas, hooks, rate limit) sem subir o listener nem
 * os serviços de background (Web3Listener/ExpirationWorker). Separado de
 * server.ts para permitir testar rotas via `.inject()` sem abrir uma conexão
 * WSS real ou uma porta TCP.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Logger único e compartilhado com o resto da aplicação (src/lib/logger.ts)
    // em vez de cada camada decidir formato/nível por conta própria. O cast é
    // só pra contornar um desalinhamento de tipos entre a versão do pino e a
    // interface interna do Fastify (msgPrefix) — a instância real é 100%
    // compatível em runtime, o Fastify só chama .info/.warn/.error/.child nela.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // Nenhuma rota atual precisa de payloads grandes; reduz o custo de parse
    // de bodies maliciosamente grandes (default do Fastify é 1MB).
    bodyLimit: Number(process.env.BODY_LIMIT_BYTES) || 100 * 1024,
    trustProxy: resolveTrustProxy(),
    ajv: {
      customOptions: {
        // amount aceita number | string no schema de POST /v1/payments (union type)
        allowUnionTypes: true,
        // Sem isso, o Fastify remove silenciosamente campos desconhecidos em vez
        // de rejeitar com 400 quando additionalProperties: false é usado.
        removeAdditional: false,
      },
    },
  });

  // Registrado ANTES das rotas (ao contrário do Express) — internamente usa o
  // hook de ciclo de vida onError do Fastify para capturar erros de rota.
  // shouldHandleError restringe a captura a erros de servidor (5xx) — sem
  // isso, respostas 4xx esperadas (429 de rate limit, 400 de validação Ajv)
  // são reportadas como exceções não tratadas e viram ruído no Sentry.
  Sentry.setupFastifyErrorHandler(app, {
    shouldHandleError: (error) => {
      const statusCode = (error as { statusCode?: number }).statusCode;
      return statusCode === undefined || statusCode >= 500;
    },
  });

  const apiKeyRaw = process.env.API_KEY;
  // Uma ou mais chaves (troca sem downtime) — ver src/lib/apiKeys.ts.
  const apiKeys = parseApiKeys(apiKeyRaw);
  const rateLimitMax = Number(process.env.RATE_LIMIT_MAX) || 100;
  const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000;

  // Health check público direto (liveness): só diz que o processo HTTP está de
  // pé. É o que o Railway usa (railway.json) — não consulta dependência de
  // propósito, para um soluço do banco não virar reinício em loop do container.
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // Readiness: o processo consegue atender de verdade — banco responde e, com
  // o servidor completo no ar, o RPC da Base também (checagem registrada pelo
  // server.ts). Para monitoramento externo e diagnóstico, não para o
  // healthcheck do deploy. Público como /health, então só expõe
  // ok/error/timeout/stale, nunca o erro cru.
  app.get('/health/ready', async (_request, reply) => {
    const checks = await runReadinessChecks();
    const ready = Object.values(checks).every((result) => result === 'ok');
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  // Documentação OpenAPI, gerada a partir dos schemas Fastify já usados para
  // validação — uma única fonte de verdade, sem duplicar contrato em lugar nenhum.
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'ContaGateway API',
        description: 'Gateway de pagamentos que conecta cobranças Pix (via conta.vc) à liquidação on-chain em cBRL na rede Base.',
        version: process.env.npm_package_version || '1.0.0',
      },
      servers: [{ url: '/' }],
      tags: [{ name: 'Payments', description: 'Criação e consulta de cobranças Pix' }],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey',
            name: 'X-API-Key',
            in: 'header',
            description: 'Chave de API do ContaGateway (também aceita `Authorization: Bearer <chave>`).',
          },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/documentation' });

  // 1. Configura Rate Limiting (Redis opt-in: presente se REDIS_URL estiver configurado)
  const redis = createRedisClient();
  if (redis) {
    redis.connect().catch(() => {/* erro já logado pelo handler 'error' do cliente */});
    logger.info('[RateLimit] Redis conectado — contagem de rate limit compartilhada entre instâncias.');
  } else {
    logger.info('[RateLimit] REDIS_URL não configurado — rate limit operando em memória (instância única).');
  }

  await app.register(rateLimit, {
    max: rateLimitMax,
    timeWindow: rateLimitWindowMs,
    ...(redis ? { redis } : {}),
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Limite de requisições excedido. Máximo de ${context.max} requisições a cada ${context.after}.`,
    }),
  });

  // 2. Middleware de Autenticação via X-API-Key
  app.addHook('onRequest', async (request, reply) => {
    // Libera rotas públicas acessadas por clientes finais no navegador sem chave secreta.
    // Avalia exclusivamente o pathname parseado (sem query string ou fragmento) com formatos ancorados
    // para evitar bypass de autenticação via query params (ex: ?x=/status).
    let pathname: string;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      pathname = request.url.split(/[?#]/)[0] ?? '';
    }

    if (
      pathname === '/health' ||
      pathname.startsWith('/health/') ||
      pathname === '/documentation' ||
      pathname.startsWith('/documentation/') ||
      PAY_ROUTE_REGEX.test(pathname) ||
      QRCODE_ROUTE_REGEX.test(pathname) ||
      STATUS_ROUTE_REGEX.test(pathname)
    ) {
      return;
    }

    // API_KEY ausente: sem autenticação (fora de produção; em produção o boot
    // recusa — ver assertRequiredEnv). API_KEY definida mas sem nenhuma chave
    // útil (ex: ","): NÃO cai aqui — apiKeys vazio faz toda requisição dar
    // 401, falha fechada em vez de desligar a autenticação em silêncio.
    if (!apiKeyRaw) {
      return;
    }

    const authHeader = request.headers['x-api-key'] || request.headers['authorization'];
    let providedKey = '';

    if (typeof authHeader === 'string') {
      providedKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
    }

    if (!providedKey || !apiKeyMatches(providedKey, apiKeys)) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Acesso não autorizado. Chave de API inválida ou ausente no cabeçalho X-API-Key.',
      });
    }
  });

  // 3. Registra rotas da API
  await app.register(paymentRoutes);

  return app;
}
