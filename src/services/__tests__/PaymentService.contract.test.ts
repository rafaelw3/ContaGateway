import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PaymentService, IdempotencyConflictError } from '../PaymentService.js';
import { prisma } from '../../lib/prisma.js';
import { ContaVcContractDriftError } from '../../lib/contractGuard.js';
import * as contractGuard from '../../lib/contractGuard.js';
import { buildPixEmv, startContaVcFake } from './fixtures/contaVcFake.js';

/**
 * Teste de contrato com a conta.vc SEM tocar na conta.vc: um servidor falso
 * em 127.0.0.1 faz o papel do endpoint interno `/api/pay/intent`. O canário
 * sintético com POST real foi rejeitado de propósito (DECISIONS.md,
 * 2026-09-17) — isto cobre o outro lado da mesma pergunta: "se o formato
 * mudar, o ContaGateway percebe e recusa, ou segue em frente com lixo?".
 *
 * Dois sentidos:
 * - o que ENVIAMOS (payload e headers) continua no formato que o checkout
 *   web deles usa — se alguém mudar isso sem querer, o teste falha;
 * - o que RECEBEMOS fora do formato bloqueia a cobrança com
 *   ContaVcContractDriftError (e alerta), em vez de gravar um Pix inválido.
 */

let fake: Awaited<ReturnType<typeof startContaVcFake>>;
let service: PaymentService;
const originalIntentUrl = process.env.CONTA_VC_INTENT_URL;
const createdIds: string[] = [];

const inFifteenMinutes = () => new Date(Date.now() + 15 * 60 * 1000).toISOString();

beforeAll(async () => {
  fake = await startContaVcFake();
  process.env.CONTA_VC_INTENT_URL = fake.intentUrl;
  service = new PaymentService();
});

afterAll(async () => {
  process.env.CONTA_VC_INTENT_URL = originalIntentUrl;
  await fake.close();
});

afterEach(async () => {
  vi.restoreAllMocks();
  fake.requests.length = 0;
  if (createdIds.length > 0) {
    await prisma.payment.deleteMany({ where: { id: { in: createdIds } } });
    createdIds.length = 0;
  }
});

describe('conta.vc — o que enviamos', () => {
  it('faz POST com handle, amountCents em centavos inteiros e message truncada em 140', async () => {
    fake.respondWith(() => ({
      status: 200,
      body: { qrId: `qr-${Date.now()}-${Math.random()}`, emv: buildPixEmv(1050), amountCents: 1050, expiresAt: inFifteenMinutes() },
    }));

    const payment = await service.createPayment({ amount: 10.5, message: 'x'.repeat(200) });
    createdIds.push(payment.id);

    expect(fake.requests).toHaveLength(1);
    const [req] = fake.requests;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/pay/intent');
    expect(req.headers['content-type']).toMatch(/application\/json/);

    const sent = JSON.parse(req.body);
    expect(Object.keys(sent).sort()).toEqual(['amountCents', 'handle', 'message']);
    expect(sent.handle).toBe(process.env.CONTA_VC_USERNAME);
    expect(sent.amountCents).toBe(1050);
    expect(Number.isInteger(sent.amountCents)).toBe(true);
    expect(sent.message).toHaveLength(140);
  });
});

describe('conta.vc — resposta no formato esperado', () => {
  it('persiste a cobrança PENDING com o EMV, o qrId e o expiresAt devolvidos', async () => {
    const qrId = `qr-ok-${Date.now()}`;
    const emv = buildPixEmv(2500);
    const expiresAt = inFifteenMinutes();
    fake.respondWith(() => ({ status: 200, body: { qrId, emv, amountCents: 2500, expiresAt } }));

    const payment = await service.createPayment({ amount: 25 });
    createdIds.push(payment.id);

    expect(payment.status).toBe('PENDING');
    expect(payment.pixPayload).toBe(emv);
    expect(payment.qrId).toBe(qrId);
    expect(new Date(payment.expiresAt).toISOString()).toBe(expiresAt);
    expect(payment.receiptCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('aceita EMV sem o campo de valor (QR dinâmico), sem alertar', async () => {
    const reportSpy = vi.spyOn(contractGuard, 'reportContractDrift').mockImplementation(() => undefined);
    fake.respondWith(() => ({
      status: 200,
      body: { qrId: `qr-dyn-${Date.now()}`, emv: buildPixEmv(), amountCents: 700, expiresAt: inFifteenMinutes() },
    }));

    const payment = await service.createPayment({ amount: 7 });
    createdIds.push(payment.id);

    expect(payment.status).toBe('PENDING');
    expect(reportSpy).not.toHaveBeenCalled();
  });
});

describe('conta.vc — drift na resposta bloqueia a cobrança e alerta', () => {
  const driftCases: Array<{ nome: string; body: unknown; contentType?: string }> = [
    {
      nome: 'campo emv renomeado (ex: pixCode)',
      body: { qrId: 'qr-x', pixCode: buildPixEmv(1000), amountCents: 1000, expiresAt: inFifteenMinutes() },
    },
    {
      nome: 'qrId renomeado (ex: id)',
      body: { id: 'qr-x', emv: buildPixEmv(1000), amountCents: 1000, expiresAt: inFifteenMinutes() },
    },
    {
      nome: 'resposta embrulhada num envelope ({ data: {...} })',
      body: { data: { qrId: 'qr-x', emv: buildPixEmv(1000), amountCents: 1000, expiresAt: inFifteenMinutes() } },
    },
    {
      nome: 'HTML no lugar de JSON (ex: página de desafio anti-bot)',
      body: '<!DOCTYPE html><html><body>Checking your browser…</body></html>',
      contentType: 'text/html',
    },
    {
      nome: 'EMV com CRC corrompido',
      body: { qrId: 'qr-x', emv: buildPixEmv(1000).slice(0, -4) + '0000', amountCents: 1000, expiresAt: inFifteenMinutes() },
    },
    {
      nome: 'EMV que não é Pix (string opaca)',
      body: { qrId: 'qr-x', emv: 'https://app.conta.vc/pay/qr/abc', amountCents: 1000, expiresAt: inFifteenMinutes() },
    },
    {
      nome: 'EMV cobrando valor diferente do pedido',
      body: { qrId: 'qr-x', emv: buildPixEmv(10000), amountCents: 1000, expiresAt: inFifteenMinutes() },
    },
    {
      nome: 'expiresAt em epoch numérico em vez de ISO string',
      body: { qrId: 'qr-x', emv: buildPixEmv(1000), amountCents: 1000, expiresAt: Date.now() + 900_000 },
    },
    {
      nome: 'expiresAt já vencido',
      body: { qrId: 'qr-x', emv: buildPixEmv(1000), amountCents: 1000, expiresAt: new Date(Date.now() - 1000).toISOString() },
    },
  ];

  for (const { nome, body, contentType } of driftCases) {
    it(nome, async () => {
      const reportSpy = vi.spyOn(contractGuard, 'reportContractDrift').mockImplementation(() => undefined);
      fake.respondWith(() => ({ status: 200, body, contentType }));

      const before = await prisma.payment.count();
      await expect(service.createPayment({ amount: 10 })).rejects.toThrow(ContaVcContractDriftError);

      expect(reportSpy).toHaveBeenCalledWith('createPayment', expect.any(Object));
      // Nada é gravado: um Pix inválido nunca chega ao pagador.
      expect(await prisma.payment.count()).toBe(before);
    });
  }

  it('amountCents divergente no corpo (mas EMV correto) só alerta, não bloqueia', async () => {
    const reportSpy = vi.spyOn(contractGuard, 'reportContractDrift').mockImplementation(() => undefined);
    fake.respondWith(() => ({
      status: 200,
      body: { qrId: `qr-mismatch-${Date.now()}`, emv: buildPixEmv(1000), amountCents: 999, expiresAt: inFifteenMinutes() },
    }));

    const payment = await service.createPayment({ amount: 10 });
    createdIds.push(payment.id);

    expect(payment.status).toBe('PENDING');
    expect(reportSpy).toHaveBeenCalledWith('createPayment.amountCents_mismatch', expect.any(Object));
  });

  it('erro HTTP da conta.vc vira falha comum (não drift), sem gravar nada', async () => {
    const reportSpy = vi.spyOn(contractGuard, 'reportContractDrift').mockImplementation(() => undefined);
    fake.respondWith(() => ({ status: 404, body: { error: 'handle not found' } }));

    await expect(service.createPayment({ amount: 10 })).rejects.toThrow(/Status 404/);
    expect(reportSpy).not.toHaveBeenCalled();
  });
});

describe('conta.vc — consulta de status do intent (getIntentStatus)', () => {
  it('consulta em CONTA_VC_INTENT_URL/<qrId>, não numa URL fixa da conta.vc real', async () => {
    fake.respondWith(() => ({ status: 200, body: { status: 'done', amountCents: 1000 } }));

    const result = await service.getIntentStatus('qr/com barra');

    expect(result).toEqual({ status: 'done', amountCents: 1000 });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].method).toBe('GET');
    expect(fake.requests[0].url).toBe('/api/pay/intent/qr%2Fcom%20barra');
  });

  it('status desconhecido é devolvido, mas alerta drift', async () => {
    const reportSpy = vi.spyOn(contractGuard, 'reportContractDrift').mockImplementation(() => undefined);
    fake.respondWith(() => ({ status: 200, body: { status: 'settled' } }));

    const result = await service.getIntentStatus('qr-1');

    expect(result?.status).toBe('settled');
    expect(reportSpy).toHaveBeenCalledWith('getIntentStatus.unknown_status', expect.any(Object));
  });

  it('sucesso HTTP sem campo status (ex: renomeado para state) alerta drift e devolve null', async () => {
    const reportSpy = vi.spyOn(contractGuard, 'reportContractDrift').mockImplementation(() => undefined);
    fake.respondWith(() => ({ status: 200, body: { state: 'done' } }));

    expect(await service.getIntentStatus('qr-2')).toBeNull();
    expect(reportSpy).toHaveBeenCalledWith(
      'getIntentStatus.missing_status',
      expect.objectContaining({ receivedKeys: ['state'] })
    );
  });

  it('404 devolve null sem alertar drift (qrId desconhecido é caso normal)', async () => {
    const reportSpy = vi.spyOn(contractGuard, 'reportContractDrift').mockImplementation(() => undefined);
    fake.respondWith(() => ({ status: 404, body: { error: 'not found' } }));

    expect(await service.getIntentStatus('qr-3')).toBeNull();
    expect(reportSpy).not.toHaveBeenCalled();
  });
});

describe('Idempotency-Key — corrida (a checagem inicial passa, o insert colide)', () => {
  // Simula duas requisições com a mesma chave chegando quase juntas: a nossa
  // passa pela checagem inicial (ainda não há linha), e enquanto espera a
  // conta.vc responder, a "outra" grava a cobrança com essa chave. O insert
  // da nossa colide (P2002) e cai no caminho de recuperação.
  const insertWinner = async (idempotencyKey: string, amount: string) => {
    const winner = await prisma.payment.create({
      data: {
        amount,
        status: 'PENDING',
        pixPayload: buildPixEmv(Math.round(Number(amount) * 100)),
        idempotencyKey,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    createdIds.push(winner.id);
    return winner;
  };

  it('mesmo valor → devolve a cobrança vencedora', async () => {
    const idempotencyKey = `race-same-${Date.now()}-${Math.random()}`;
    let winnerId = '';
    fake.respondWith(async () => {
      winnerId = (await insertWinner(idempotencyKey, '10.00')).id;
      return { status: 200, body: { qrId: `qr-race-${Date.now()}`, emv: buildPixEmv(1000), amountCents: 1000, expiresAt: inFifteenMinutes() } };
    });

    const result = await service.createPayment({ amount: 10, idempotencyKey });

    expect(result.id).toBe(winnerId);
    expect(await prisma.payment.count({ where: { idempotencyKey } })).toBe(1);
  });

  it('valor diferente → IdempotencyConflictError, não devolve a cobrança do outro valor', async () => {
    const idempotencyKey = `race-diff-${Date.now()}-${Math.random()}`;
    fake.respondWith(async () => {
      await insertWinner(idempotencyKey, '99.00');
      return { status: 200, body: { qrId: `qr-race-${Date.now()}`, emv: buildPixEmv(1000), amountCents: 1000, expiresAt: inFifteenMinutes() } };
    });

    await expect(service.createPayment({ amount: 10, idempotencyKey })).rejects.toThrow(IdempotencyConflictError);
    expect(await prisma.payment.count({ where: { idempotencyKey } })).toBe(1);
  });
});
