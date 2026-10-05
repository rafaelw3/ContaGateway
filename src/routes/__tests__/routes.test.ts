import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { clearReadinessChecks, registerReadinessCheck } from '../../lib/readiness.js';

const API_KEY = process.env.API_KEY!;
const createdIds: string[] = [];

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  if (createdIds.length > 0) {
    await prisma.payment.deleteMany({ where: { id: { in: createdIds } } });
    createdIds.length = 0;
  }
});

describe('POST /v1/payments — validação (sem chamar a conta.vc)', () => {
  it('rejeita amount ausente com 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { 'x-api-key': API_KEY },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/amount/);
  });

  // O valor é a única coisa que o pagador realmente paga: a API recusa
  // qualquer entrada que exigiria "ajustar" o valor pedido. Ver
  // src/lib/paymentValidation.ts.
  it('rejeita mais de 2 casas decimais com 400, em vez de arredondar', async () => {
    for (const amount of ['10.555', '1.004', '0.001']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments',
        headers: { 'x-api-key': API_KEY },
        payload: { amount },
      });
      expect(res.statusCode, `amount ${amount} deveria ser recusado`).toBe(400);
      expect(res.json().message).toMatch(/casas decimais|inteiro/);
    }
  });

  it('rejeita amount e amountCents juntos com 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { 'x-api-key': API_KEY },
      payload: { amount: '10.50', amountCents: 999 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/nunca os dois/);
  });

  it('rejeita amountCents não inteiro com 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { 'x-api-key': API_KEY },
      payload: { amountCents: 10.5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('aceita amountCents e só então tenta o provedor (502 com a conta.vc inalcançável)', async () => {
    // Prova que amountCents passa a validação: o 502 vem da chamada externa
    // (URL inalcançável no .env.test), não de recusa de valor.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { 'x-api-key': API_KEY },
      payload: { amountCents: 1050 },
    });
    expect(res.statusCode).toBe(502);
  });

  it('rejeita campo desconhecido no body com 400 (additionalProperties)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { 'x-api-key': API_KEY },
      payload: { amount: 10, campoInventado: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/additional properties/);
  });

  it('rejeita amount não-finito (Infinity via notação exponencial)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { 'x-api-key': API_KEY },
      payload: { amount: '1e400' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejeita webhookUrl apontando para IP privado (SSRF)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { 'x-api-key': API_KEY },
      payload: { amount: 10, webhookUrl: 'https://127.0.0.1:9999/hook' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/privado|reservado/);
  });

  it('rejeita webhookUrl http (o despacho só entrega em https)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { 'x-api-key': API_KEY },
      payload: { amount: 10, webhookUrl: 'http://8.8.8.8/hook' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/https/);
  });

  it('rejeita metadata com profundidade excessiva', async () => {
    let deep: any = {};
    let cur = deep;
    for (let i = 0; i < 10; i++) {
      cur.child = {};
      cur = cur.child;
    }
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { 'x-api-key': API_KEY },
      payload: { amount: 10, metadata: deep },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/profundidade/);
  });

  it('passa da validação e tenta chamar o provedor (502, já que a URL de teste é inalcançável)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { 'x-api-key': API_KEY },
      payload: { amount: 10 },
    });
    // Confirma que passou por toda a validação e chegou a tentar a chamada
    // externa — sem de fato completar uma cobrança real.
    expect(res.statusCode).toBe(502);
  });

  it('exige X-API-Key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      payload: { amount: 10 },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/payments — Idempotency-Key', () => {
  const seed = async (idempotencyKey: string, amount: string) => {
    const payment = await prisma.payment.create({
      data: {
        amount,
        status: 'PENDING',
        pixPayload: 'dummy-idem-route',
        idempotencyKey,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    createdIds.push(payment.id);
    return payment;
  };

  it('mesma chave e mesmo valor → 201 com a cobrança já existente', async () => {
    const key = `route-idem-same-${Date.now()}`;
    const existing = await seed(key, '10.00');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { 'x-api-key': API_KEY, 'idempotency-key': key },
      payload: { amount: 10 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.id).toBe(existing.id);
  });

  it('mesma chave e valor diferente → 422, sem 502 genérico', async () => {
    const key = `route-idem-diff-${Date.now()}`;
    await seed(key, '10.00');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { 'x-api-key': API_KEY, 'idempotency-key': key },
      payload: { amount: 50 },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/Idempotency-Key/);
    expect(res.json().message).toMatch(/10\.00/);
    expect(res.json().message).toMatch(/50\.00/);
  });
});

describe('API_KEY com várias chaves (troca sem downtime)', () => {
  const url = '/v1/payments/cabcdefghijklmnopqrstuvwx';
  const original = process.env.API_KEY;

  afterEach(() => {
    process.env.API_KEY = original;
  });

  async function appWith(apiKey: string) {
    process.env.API_KEY = apiKey;
    const other = await buildApp();
    await other.ready();
    return other;
  }

  it('aceita a nova e a antiga durante a troca; recusa qualquer outra', async () => {
    const other = await appWith('chave-nova, chave-antiga');
    try {
      const nova = await other.inject({ method: 'GET', url, headers: { 'x-api-key': 'chave-nova' } });
      const antiga = await other.inject({ method: 'GET', url, headers: { authorization: 'Bearer chave-antiga' } });
      const errada = await other.inject({ method: 'GET', url, headers: { 'x-api-key': 'chave-nova,chave-antiga' } });
      expect(nova.statusCode).toBe(404);
      expect(antiga.statusCode).toBe(404);
      expect(errada.statusCode).toBe(401);
    } finally {
      await other.close();
    }
  });

  it('API_KEY só com vírgulas: recusa tudo em vez de desligar a autenticação', async () => {
    const other = await appWith(' , ');
    try {
      const semChave = await other.inject({ method: 'GET', url });
      const comVirgula = await other.inject({ method: 'GET', url, headers: { 'x-api-key': ',' } });
      expect(semChave.statusCode).toBe(401);
      expect(comVirgula.statusCode).toBe(401);
    } finally {
      await other.close();
    }
  });
});

describe('GET /v1/payments/:id — validação de params e 404', () => {
  it('rejeita id com formato inválido antes de tocar o banco', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/payments/id-muito-curto',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(400);
  });

  it('retorna 404 para id de formato válido mas inexistente', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/payments/cabcdefghijklmnopqrstuvwx',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(404);
  });

  it('recusa chave errada (mesmo tamanho, prefixo certo) e aceita a certa, via X-API-Key e Bearer', async () => {
    const quaseCerta = API_KEY.slice(0, -1) + (API_KEY.endsWith('x') ? 'y' : 'x');
    const url = '/v1/payments/cabcdefghijklmnopqrstuvwx';

    const errada = await app.inject({ method: 'GET', url, headers: { 'x-api-key': quaseCerta } });
    expect(errada.statusCode).toBe(401);

    const certaHeader = await app.inject({ method: 'GET', url, headers: { 'x-api-key': API_KEY } });
    expect(certaHeader.statusCode).toBe(404);

    const certaBearer = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${API_KEY}` } });
    expect(certaBearer.statusCode).toBe(404);
  });

  it('exige X-API-Key nesta rota (não é pública)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/payments/cabcdefghijklmnopqrstuvwx',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Rotas públicas de checkout não exigem X-API-Key', () => {
  it('/pay/:id não exige API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/pay/cabcdefghijklmnopqrstuvwx' });
    expect(res.statusCode).not.toBe(401);
  });

  it('/v1/payments/:id/qrcode não exige API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/payments/cabcdefghijklmnopqrstuvwx/qrcode' });
    expect(res.statusCode).not.toBe(401);
  });

  it('/v1/payments/:id/status não exige API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/payments/cabcdefghijklmnopqrstuvwx/status' });
    expect(res.statusCode).not.toBe(401);
  });

  it('/health não exige API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /health/ready — readiness com banco', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('200 ready quando o banco responde, sem exigir API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', checks: { database: 'ok' } });
  });

  it('503 not_ready quando o banco falha, sem vazar a mensagem do erro', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(
      new Error("Can't reach database server at `db-segredo.interno:5432` user=admin")
    );

    const res = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'not_ready', checks: { database: 'error' } });
    expect(res.body).not.toContain('db-segredo');
    expect(res.body).not.toContain('admin');
  });

  it('503 quando o RPC da Base está sem responder (checagem web3 registrada pelo server.ts)', async () => {
    registerReadinessCheck('web3', () => 'stale');
    try {
      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json().checks).toEqual({ database: 'ok', web3: 'stale' });
    } finally {
      clearReadinessChecks();
    }
  });

  it('200 quando banco e web3 estão ok', async () => {
    registerReadinessCheck('web3', () => 'ok');
    try {
      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(200);
      expect(res.json().checks).toEqual({ database: 'ok', web3: 'ok' });
    } finally {
      clearReadinessChecks();
    }
  });

  it('/health (liveness) continua 200 mesmo com o banco fora', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('down'));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('Contrato de resposta — campos internos não vazam', () => {
  it('nao expoe webhookUrl/webhookStatus/idempotencyKey na consulta nem na criacao', async () => {
    const future = new Date(Date.now() + 15 * 60 * 1000);
    const payment = await prisma.payment.create({
      data: {
        amount: '12.34',
        status: 'PENDING',
        pixPayload: 'dummy-leak-test',
        expiresAt: future,
        webhookUrl: 'https://integrador.example.com/hook?token=segredo',
        webhookStatus: 'PENDING',
        idempotencyKey: 'idem-leak-test-key',
        transactionHash: '0xdeadbeef',
      },
    });
    createdIds.push(payment.id);

    // Campos que NUNCA podem aparecer na resposta publica. webhookUrl carrega
    // token do integrador na query string; idempotencyKey e chave de criacao.
    const proibidos = ['webhookUrl', 'webhookStatus', 'idempotencyKey', 'token=segredo'];

    const res = await app.inject({
      method: 'GET',
      url: `/v1/payments/${payment.id}`,
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);

    const raw = res.body;
    for (const campo of proibidos) {
      expect(raw).not.toContain(campo);
    }

    // A serializacao e allowlist: a lista de chaves e exatamente a esperada,
    // entao uma coluna nova no schema nao vaza sozinha.
    const data = res.json().data;
    expect(Object.keys(data).sort()).toEqual(
      [
        'amount', 'amountCents', 'createdAt', 'expiresAt', 'id', 'metadata',
        'paymentUrl', 'paidAt', 'pixPayload', 'qrCode', 'qrCodeUrl', 'qrId',
        'receiptCode', 'status', 'transactionHash',
      ].sort()
    );
    // transactionHash e tecnico, mas permitido nesta rota autenticada.
    expect(data.transactionHash).toBe('0xdeadbeef');
  });

  it('o schema de resposta e o que drena campos internos (defesa em profundidade)', async () => {
    // PROVA DE MORDIDA: a serializacao pela allowlist do response schema do
    // Fastify e o que descarta chaves nao declaradas. Se alguem remover o
    // response schema da rota (ou troca-lo por um permissivo), o handler volta
    // a espalhar a row inteira e este teste falha. Sem ele, a remocao do
    // schema passaria em silencio.
    const { getPaymentDataSchema } = await import('../routes.js');
    const props = Object.keys(getPaymentDataSchema.properties ?? {});

    for (const proibido of ['webhookUrl', 'webhookStatus', 'idempotencyKey']) {
      expect(props).not.toContain(proibido);
    }
    // O schema precisa declarar os campos publicos para nao drenar demais.
    for (const publico of ['id', 'status', 'amount', 'amountCents', 'expiresAt', 'receiptCode']) {
      expect(props).toContain(publico);
    }
  });

  it('nao expoe transactionHash na criacao (rota de menor confianca)', async () => {
    // A criacao nunca deve devolver transactionHash — o pagador ainda nem pagou.
    // Aqui so validamos o serializer diretamente, porque a rota de criacao
    // depende de chamada externa a conta.vc.
    const { serializePaymentResponse } = await import('../routes.js');
    const fake = {
      id: 'x', amount: '1', status: 'PENDING', pixPayload: 'p', qrId: null,
      receiptCode: null, expiresAt: new Date(), createdAt: new Date(),
      metadata: null, transactionHash: '0xshibboleth', webhookUrl: 'https://s.example.com/h?k=v',
      webhookStatus: 'PENDING', idempotencyKey: 'k',
    } as any;

    const created = serializePaymentResponse(fake, { qrCode: 'c', qrCodeUrl: 'u', paymentUrl: 'l' }, 'create');
    expect(created).not.toHaveProperty('transactionHash');
    expect(created).not.toHaveProperty('webhookUrl');
    expect(created).not.toHaveProperty('webhookStatus');
    expect(created).not.toHaveProperty('idempotencyKey');

    const fetched = serializePaymentResponse(fake, { qrCode: 'c', qrCodeUrl: 'u', paymentUrl: 'l' }, 'get');
    expect(fetched).toHaveProperty('transactionHash', '0xshibboleth');
    expect(fetched).not.toHaveProperty('webhookUrl');
  });
});

describe('Host header spoofing', () => {
  it('ignora X-Forwarded-Host/Proto forjados sem TRUST_PROXY configurado', async () => {
    const future = new Date(Date.now() + 15 * 60 * 1000);
    const payment = await prisma.payment.create({
      data: { amount: '5.00', status: 'PENDING', pixPayload: 'dummy-spoof-test', expiresAt: future },
    });
    createdIds.push(payment.id);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/payments/${payment.id}`,
      headers: {
        'x-api-key': API_KEY,
        'x-forwarded-host': 'evil.com',
        'x-forwarded-proto': 'https',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.paymentUrl).not.toContain('evil.com');
    expect(body.data.qrCodeUrl).not.toContain('evil.com');
  });
});

describe('POST /v1/payments/:id/webhook/retry', () => {
  it('retorna 404 para pagamento inexistente', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/aaaaabbbbbcccccdddddeeeee/webhook/retry',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(404);
  });

  it('retorna 409 para pagamento não-PAID', async () => {
    const future = new Date(Date.now() + 15 * 60 * 1000);
    const payment = await prisma.payment.create({
      data: { amount: '10.00', status: 'PENDING', pixPayload: 'dummy-retry-pending', expiresAt: future },
    });
    createdIds.push(payment.id);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/payments/${payment.id}/webhook/retry`,
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/PAID/);
  });

  it('retorna 400 para pagamento PAID sem webhookUrl', async () => {
    const past = new Date(Date.now() - 5 * 60 * 1000);
    const payment = await prisma.payment.create({
      data: {
        amount: '20.00',
        status: 'PAID',
        pixPayload: 'dummy-retry-no-url',
        expiresAt: past,
        webhookUrl: null,
        transactionHash: `0xretry-no-url-${Date.now()}`,
      },
    });
    createdIds.push(payment.id);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/payments/${payment.id}/webhook/retry`,
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/webhookUrl/);
  });

  it('retorna 409 para pagamento com webhookStatus DELIVERED', async () => {
    const past = new Date(Date.now() - 5 * 60 * 1000);
    const payment = await prisma.payment.create({
      data: {
        amount: '30.00',
        status: 'PAID',
        pixPayload: 'dummy-retry-delivered',
        expiresAt: past,
        webhookUrl: 'https://example.com/webhook',
        webhookStatus: 'DELIVERED',
        transactionHash: `0xretry-delivered-${Date.now()}`,
      },
    });
    createdIds.push(payment.id);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/payments/${payment.id}/webhook/retry`,
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/entregue/);
  });

  it('retorna 200 e enfileira reenvio para pagamento PAID com webhook FAILED', async () => {
    const past = new Date(Date.now() - 5 * 60 * 1000);
    const payment = await prisma.payment.create({
      data: {
        amount: '50.00',
        status: 'PAID',
        pixPayload: 'dummy-retry-failed',
        expiresAt: past,
        webhookUrl: 'https://example.com/webhook',
        webhookStatus: 'FAILED',
        transactionHash: `0xretry-failed-${Date.now()}`,
      },
    });
    createdIds.push(payment.id);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/payments/${payment.id}/webhook/retry`,
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('requer autenticação (401 sem X-API-Key)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/aaaaabbbbbcccccdddddeeeee/webhook/retry',
    });
    expect(res.statusCode).toBe(401);
  });
});
