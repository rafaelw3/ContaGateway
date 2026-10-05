import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { paymentService, IdempotencyConflictError } from '../services/PaymentService.js';
import { webhookService } from '../services/WebhookService.js';
import { qrCodeService } from '../services/QRCodeService.js';
import { renderCheckoutHtml } from '../views/checkoutHtml.js';
import { type Payment, type Prisma } from '../lib/prisma.js';
import {
  parseAmountToCents,
  isAmountParseFailure,
  formatCentsAsAmount,
  centsFromStoredAmount,
} from '../lib/paymentValidation.js';
import { assertPublicWebhookUrl } from '../lib/webhookSecurity.js';
import { assertBoundedJson } from '../lib/jsonGuard.js';

interface CreatePaymentBody {
  amount?: number | string;
  amountCents?: number | string;
  message?: string;
  metadata?: Record<string, unknown>;
  webhookUrl?: string;
}

interface PaymentParams {
  id: string;
}

// cuid padrão do Prisma tem 25 chars, mas mantemos uma faixa levemente mais
// ampla para não acoplar demais ao algoritmo, ainda limitando o payload.
const PAYMENT_ID_PATTERN = '^[a-zA-Z0-9]{20,40}$';

const paymentIdParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', pattern: PAYMENT_ID_PATTERN },
  },
} as const;

// Sem `required`: o valor pode vir em `amount` ou em `amountCents`, e exigir
// um dos dois no JSON Schema daria uma mensagem de erro pior do que a do
// parser (que explica a regra de centavos). A obrigatoriedade é validada no
// handler, via parseAmountToCents.
const createPaymentBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    amount: {
      type: ['number', 'string'],
      description:
        'Valor da cobrança em BRL, com no máximo 2 casas decimais (ex: 10.50). Mais casas são recusadas com 400 — ' +
        'arredondar mudaria o valor cobrado. Exclusivo com `amountCents`.',
    },
    amountCents: {
      type: ['integer', 'string'],
      description:
        'Valor da cobrança em centavos inteiros (ex: 1050 = R$ 10,50). É a unidade usada pela conta.vc e a forma ' +
        'recomendada de integrar, por não ter ambiguidade de arredondamento. Exclusivo com `amount`.',
    },
    message: { type: 'string', maxLength: 140, description: 'Mensagem exibida na página de checkout.' },
    metadata: { type: 'object', description: 'Dados arbitrários do integrador, devolvidos junto com o pagamento.' },
    webhookUrl: { type: 'string', minLength: 1, maxLength: 2048, description: 'URL HTTPS pública que recebe a notificação quando o pagamento é confirmado.' },
  },
} as const;

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
} as const;

export const createPaymentDataSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    amount: { type: 'string', description: 'Valor em reais, sempre com 2 casas decimais (ex: "10.50").' },
    amountCents: { type: 'integer', description: 'O mesmo valor em centavos inteiros (ex: 1050) — unidade canônica, sem arredondamento.' },
    status: { type: 'string', enum: ['PENDING', 'PAID', 'EXPIRED', 'MISROUTED'] },
    pixPayload: { type: 'string', description: 'Payload Pix "copia e cola".' },
    qrId: { type: 'string', nullable: true },
    qrCode: { type: 'string', description: 'QR Code em Data URL (base64), pronto para uso em <img src>.' },
    qrCodeUrl: { type: 'string' },
    paymentUrl: { type: 'string', description: 'Página de checkout hospedada para o pagador.' },
    receiptCode: { type: 'string', nullable: true, description: 'Código de confirmação curto e legível (ex: "K7X9-2B3F") — seguro para mostrar ao pagador final. Nunca exponha transactionHash a ele.' },
    expiresAt: { type: 'string', format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    metadata: {},
  },
} as const;

export const getPaymentDataSchema = {
  type: 'object',
  properties: {
    ...createPaymentDataSchema.properties,
    transactionHash: { type: 'string', nullable: true, description: 'Hash da transação on-chain — dado técnico para auditoria do integrador, não deve ser mostrado ao pagador final.' },
    paidAt: { type: 'string', format: 'date-time', nullable: true, description: 'Quando o pagamento chegou on-chain (horário do bloco do mint de cBRL). Nulo enquanto não pago.' },
  },
} as const;

const METADATA_MAX_DEPTH = 5;
const METADATA_MAX_ENTRIES = 200;

// Limites por rota, sobrepostos ao rate limit global (config em server.ts).
// Rotas públicas (sem X-API-Key) que fazem geração de QR/HTML são as mais
// caras em CPU, por isso recebem tetos mais baixos.
const PAYMENT_CREATE_RATE_LIMIT_MAX = Number(process.env.PAYMENT_CREATE_RATE_LIMIT_MAX) || 30;
const QRCODE_RATE_LIMIT_MAX = Number(process.env.QRCODE_RATE_LIMIT_MAX) || 20;
const PAY_PAGE_RATE_LIMIT_MAX = Number(process.env.PAY_PAGE_RATE_LIMIT_MAX) || 30;
const WEBHOOK_RETRY_RATE_LIMIT_MAX = Number(process.env.WEBHOOK_RETRY_RATE_LIMIT_MAX) || 5;

// Usa request.protocol/hostname/port (que respeitam a opção trustProxy do
// Fastify) em vez de ler X-Forwarded-Proto/Host diretamente — sem trustProxy
// configurado, esses cabeçalhos podem ser forjados por qualquer chamador
// direto, permitindo phishing (QR/links de pagamento apontando pra um host
// controlado pelo atacante).
function getBaseUrl(request: FastifyRequest): string {
  const { protocol, hostname, port } = request;
  const isDefaultPort = (protocol === 'https' && port === 443) || (protocol === 'http' && port === 80);
  const host = port && !isDefaultPort ? `${hostname}:${port}` : hostname;
  return `${protocol}://${host}`;
}

export interface PaymentResponseExtras {
  qrCode: string;
  qrCodeUrl: string;
  paymentUrl: string;
}

export type PaymentSerializationTarget = 'create' | 'get';

/**
 * Serializa a resposta de pagamento utilizando um allowlist explícito de campos.
 * Nunca espalhar a row inteira do Prisma (...payment): fazer isso vaza colunas
 * internas e de infraestrutura (como idempotencyKey, webhookUrl e webhookStatus)
 * e qualquer coluna nova adicionada ao schema no futuro seria exposta silenciosamente.
 */
export function serializePaymentResponse(
  payment: Payment,
  extras: PaymentResponseExtras,
  target: PaymentSerializationTarget = 'get'
) {
  // `payment.amount` é um Decimal do Prisma: serializado direto, "1.00" sai
  // como "1" e o integrador exibe "R$ 1". Reformatamos a partir dos centavos,
  // que também vão explícitos na resposta.
  const amountCents = centsFromStoredAmount(payment.amount);

  const base = {
    id: payment.id,
    amount: formatCentsAsAmount(amountCents),
    amountCents,
    status: payment.status,
    pixPayload: payment.pixPayload,
    qrId: payment.qrId,
    qrCode: extras.qrCode,
    qrCodeUrl: extras.qrCodeUrl,
    paymentUrl: extras.paymentUrl,
    receiptCode: payment.receiptCode,
    expiresAt: payment.expiresAt,
    createdAt: payment.createdAt,
    metadata: payment.metadata,
  };

  if (target === 'get') {
    return {
      ...base,
      transactionHash: payment.transactionHash,
      paidAt: payment.paidAt,
    };
  }

  return base;
}

export const paymentRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /v1/payments
   * Inicia o processo gerando a cobrança Pix via conta.vc e salvando no banco
   */
  fastify.post(
    '/v1/payments',
    {
      schema: {
        tags: ['Payments'],
        summary: 'Cria uma cobrança Pix',
        description: 'Gera uma cobrança Pix via conta.vc e devolve o QR Code e o link de checkout. Aceita um cabeçalho `Idempotency-Key` opcional para reenvios seguros: reenviar a mesma chave com o mesmo valor devolve a cobrança já criada; com outro valor, responde 422. ' +
          'O valor pode vir como `amount` (reais, máximo 2 casas decimais) ou `amountCents` (centavos inteiros, recomendado).',
        security: [{ apiKey: [] }],
        body: createPaymentBodySchema,
        response: {
          201: { type: 'object', properties: { success: { type: 'boolean' }, data: createPaymentDataSchema } },
          400: errorResponseSchema,
          422: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
      config: { rateLimit: { max: PAYMENT_CREATE_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest<{ Body: CreatePaymentBody }>, reply: FastifyReply) => {
    const { amount, amountCents, message, metadata, webhookUrl } = request.body || {};

    // Suporta retries seguros: reenviar o mesmo Idempotency-Key devolve a
    // cobrança já criada em vez de gerar outra cobrança Pix real.
    const idempotencyKeyHeader = request.headers['idempotency-key'];
    const idempotencyKey = typeof idempotencyKeyHeader === 'string' ? idempotencyKeyHeader.slice(0, 200) : undefined;

    const parsedAmount = parseAmountToCents({ amount, amountCents });
    if (isAmountParseFailure(parsedAmount)) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: parsedAmount.error,
      });
    }

    if (metadata) {
      try {
        assertBoundedJson(metadata, { maxDepth: METADATA_MAX_DEPTH, maxEntries: METADATA_MAX_ENTRIES });
      } catch (err) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: (err as Error).message,
        });
      }
    }

    if (webhookUrl) {
      try {
        await assertPublicWebhookUrl(webhookUrl);
      } catch (err) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: (err as Error).message,
        });
      }
    }

    try {
      const payment = await paymentService.createPayment({
        amountCents: parsedAmount.cents,
        message,
        // Já validado por assertBoundedJson acima e originado do parser JSON
        // do Fastify, então é seguro tratar como JSON simples.
        metadata: metadata as unknown as Prisma.InputJsonValue | undefined,
        webhookUrl,
        idempotencyKey,
      });

      const baseUrl = getBaseUrl(request);
      const qrCode = await qrCodeService.generateDataURL(payment.pixPayload);
      const qrCodeUrl = `${baseUrl}/v1/payments/${payment.id}/qrcode`;
      const paymentUrl = `${baseUrl}/pay/${payment.id}`;

      return reply.status(201).send({
        success: true,
        data: serializePaymentResponse(payment, { qrCode, qrCodeUrl, paymentUrl }, 'create'),
      });
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return reply.status(422).send({
          error: 'Unprocessable Entity',
          message: err.message,
        });
      }

      const error = err as Error;
      fastify.log.error(`[POST /v1/payments] Erro: ${error.message}`);

      return reply.status(502).send({
        error: 'Bad Gateway',
        message: 'Não foi possível gerar a cobrança Pix através do provedor conta.vc.',
      });
    }
    }
  );

  /**
   * GET /v1/payments/:id
   * Consulta os dados e status de liquidação do pagamento
   */
  fastify.get(
    '/v1/payments/:id',
    {
      schema: {
        tags: ['Payments'],
        summary: 'Consulta uma cobrança',
        description: 'Retorna os dados completos e o status de liquidação de uma cobrança.',
        security: [{ apiKey: [] }],
        params: paymentIdParamsSchema,
        response: {
          200: { type: 'object', properties: { success: { type: 'boolean' }, data: getPaymentDataSchema } },
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Params: PaymentParams }>, reply: FastifyReply) => {
    const { id } = request.params;

    try {
      let payment = await paymentService.getPaymentById(id);

      if (!payment) {
        return reply.status(404).send({
          error: 'Not Found',
          message: `Pagamento com ID "${id}" não encontrado.`,
        });
      }

      // Expiração já é tratada dentro do getPaymentById.

      const baseUrl = getBaseUrl(request);
      const qrCode = await qrCodeService.generateDataURL(payment.pixPayload);
      const qrCodeUrl = `${baseUrl}/v1/payments/${payment.id}/qrcode`;
      const paymentUrl = `${baseUrl}/pay/${payment.id}`;

      return reply.send({
        success: true,
        data: serializePaymentResponse(payment, { qrCode, qrCodeUrl, paymentUrl }, 'get'),
      });
    } catch (err) {
      const error = err as Error;
      fastify.log.error(`[GET /v1/payments/${id}] Erro: ${error.message}`);

      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Erro interno ao consultar pagamento.',
      });
    }
    }
  );

  /**
   * GET /v1/payments/:id/qrcode
   * Retorna diretamente a imagem binária PNG do QR Code Pix
   */
  fastify.get(
    '/v1/payments/:id/qrcode',
    {
      schema: {
        tags: ['Payments'],
        summary: 'Imagem do QR Code Pix',
        description: 'Rota pública (sem X-API-Key) — retorna o PNG do QR Code diretamente, usada pela página de checkout.',
        params: paymentIdParamsSchema,
        response: { 404: errorResponseSchema, 500: errorResponseSchema },
      },
      config: { rateLimit: { max: QRCODE_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest<{ Params: PaymentParams }>, reply: FastifyReply) => {
    const { id } = request.params;

    try {
      const payment = await paymentService.getPaymentById(id);
      if (!payment) {
        return reply.status(404).send({ error: 'Not Found', message: 'Pagamento não encontrado.' });
      }

      const pngBuffer = await qrCodeService.generatePNG(payment.pixPayload);

      return reply
        .type('image/png')
        .header('Cache-Control', 'public, max-age=86400, immutable')
        .send(pngBuffer);
    } catch (err) {
      fastify.log.error(`[GET /v1/payments/${id}/qrcode] Erro: ${(err as Error).message}`);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Erro interno ao gerar o QR Code.' });
    }
    }
  );

  /**
   * GET /v1/payments/:id/status
   * Endpoint leve e público consumido pelo frontend do checkout para polling
   */
  fastify.get(
    '/v1/payments/:id/status',
    {
      schema: {
        tags: ['Payments'],
        summary: 'Status leve de uma cobrança',
        description: 'Rota pública (sem X-API-Key), pensada para polling frequente do frontend de checkout — resposta mínima e sem nenhum detalhe técnico de liquidação (ver `receiptCode`, seguro para exibir ao pagador final).',
        params: paymentIdParamsSchema,
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string', enum: ['PENDING', 'PAID', 'EXPIRED', 'MISROUTED'] },
              amount: { type: 'string', description: 'Valor em reais, sempre com 2 casas decimais (ex: "10.50").' },
              amountCents: { type: 'integer', description: 'O mesmo valor em centavos inteiros (ex: 1050).' },
              receiptCode: { type: 'string', nullable: true, description: 'Código de confirmação curto, seguro para mostrar ao pagador final.' },
              expiresAt: { type: 'string', format: 'date-time' },
            },
          },
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Params: PaymentParams }>, reply: FastifyReply) => {
    const { id } = request.params;

    try {
      const payment = await paymentService.getPaymentById(id);
      if (!payment) {
        return reply.status(404).send({ error: 'Not Found', message: 'Pagamento não encontrado.' });
      }

      const amountCents = centsFromStoredAmount(payment.amount);

      return reply.send({
        id: payment.id,
        status: payment.status,
        amount: formatCentsAsAmount(amountCents),
        amountCents,
        receiptCode: payment.receiptCode,
        expiresAt: payment.expiresAt,
      });
    } catch (err) {
      fastify.log.error(`[GET /v1/payments/${id}/status] Erro: ${(err as Error).message}`);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Erro interno ao consultar status do pagamento.' });
    }
    }
  );

  /**
   * GET /pay/:id
   * Página web de checkout hospedada
   */
  fastify.get(
    '/pay/:id',
    {
      schema: { params: paymentIdParamsSchema, hide: true },
      config: { rateLimit: { max: PAY_PAGE_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest<{ Params: PaymentParams }>, reply: FastifyReply) => {
    const { id } = request.params;

    try {
      const payment = await paymentService.getPaymentById(id);
      if (!payment) {
        return reply.status(404).type('text/html').send(`
          <!DOCTYPE html>
          <html lang="pt-BR">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Cobrança não encontrada | ContaGateway</title>
              <link rel="preconnect" href="https://fonts.googleapis.com">
              <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
              <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
              <style>
                :root { --surface-page: #f8fafc; --ink: #0f172a; --ink-muted: #64748b; }
                @media (prefers-color-scheme: dark) {
                  :root { --surface-page: #0b0f17; --ink: #f1f5f9; --ink-muted: #94a3b8; }
                }
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                  font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
                  background: var(--surface-page);
                  color: var(--ink);
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  min-height: 100vh;
                  padding: 24px 16px;
                  text-align: center;
                }
                h2 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
                p { color: var(--ink-muted); font-size: 14px; }
              </style>
            </head>
            <body>
              <div>
                <h2>Cobrança não encontrada</h2>
                <p>O link informado não corresponde a uma cobrança válida.</p>
              </div>
            </body>
          </html>
        `);
      }

      const baseUrl = getBaseUrl(request);
      const qrCodeDataUrl = await qrCodeService.generateDataURL(payment.pixPayload);
      const html = renderCheckoutHtml({ payment, qrCodeDataUrl, baseUrl });

      return reply.type('text/html').send(html);
    } catch (err) {
      fastify.log.error(`[GET /pay/${id}] Erro: ${(err as Error).message}`);
      return reply.status(500).type('text/html').send(`
        <!DOCTYPE html>
        <html lang="pt-BR" style="background:#07090e;color:#fff;font-family:sans-serif;">
          <body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
            <div style="text-align:center;padding:24px;">
              <h2 style="font-size:24px;margin-bottom:8px;">Erro ao carregar checkout</h2>
              <p style="color:#94a3b8;">Não foi possível carregar esta cobrança no momento. Tente novamente em instantes.</p>
            </div>
          </body>
        </html>
      `);
    }
    }
  );

  /**
   * POST /v1/payments/:id/webhook/retry
   * Reenvia manualmente o webhook de um pagamento PAID cujo webhook falhou.
   * Protegido por X-API-Key e com rate limit apertado (evita spam de retries).
   */
  fastify.post(
    '/v1/payments/:id/webhook/retry',
    {
      schema: {
        tags: ['Payments'],
        summary: 'Reenvia o webhook de um pagamento',
        description: 'Reenvia manualmente o webhook de notificação para pagamentos `PAID` com `webhookStatus` `FAILED` ou `PENDING`. Útil para recuperação sem acesso direto ao banco.',
        security: [{ apiKey: [] }],
        params: paymentIdParamsSchema,
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
            },
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
      config: { rateLimit: { max: WEBHOOK_RETRY_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest<{ Params: PaymentParams }>, reply: FastifyReply) => {
      const { id } = request.params;

      try {
        const payment = await paymentService.getPaymentById(id);

        if (!payment) {
          return reply.status(404).send({
            error: 'Not Found',
            message: `Pagamento com ID "${id}" não encontrado.`,
          });
        }

        if (payment.status !== 'PAID') {
          return reply.status(409).send({
            error: 'Conflict',
            message: `Reenvio de webhook só é permitido para pagamentos PAID. Status atual: ${payment.status}.`,
          });
        }

        if (!payment.webhookUrl) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Este pagamento não possui um webhookUrl configurado.',
          });
        }

        if (payment.webhookStatus === 'DELIVERED') {
          return reply.status(409).send({
            error: 'Conflict',
            message: 'O webhook deste pagamento já foi entregue com sucesso. Use o campo webhookStatus para confirmar.',
          });
        }

        // Disparo assíncrono — não bloqueia a resposta HTTP.
        webhookService.notifyPaymentPaid(payment);

        return reply.send({
          success: true,
          message: `Reenvio do webhook para o pagamento ${id} enfileirado com sucesso.`,
        });
      } catch (err) {
        fastify.log.error(`[POST /v1/payments/${id}/webhook/retry] Erro: ${(err as Error).message}`);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Erro interno ao enfileirar o reenvio do webhook.',
        });
      }
    }
  );
};
