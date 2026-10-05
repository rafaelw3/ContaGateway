import { describe, it, expect, afterEach, vi } from 'vitest';
import { prisma, Prisma, type Payment } from '../../src/lib/prisma.js';
import { checkResendable, listFailedDeliveries, resendWebhook } from '../resend-webhook.js';

const createdIds: string[] = [];

afterEach(async () => {
  if (createdIds.length > 0) {
    await prisma.payment.deleteMany({ where: { id: { in: createdIds } } });
    createdIds.length = 0;
  }
});

async function seed(overrides: Partial<{ status: string; webhookStatus: string | null; webhookUrl: string | null }>) {
  const payment = await prisma.payment.create({
    data: {
      amount: '12.34',
      status: 'PAID',
      pixPayload: 'dummy-resend',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      webhookUrl: 'https://integrador.example.com/hook?token=segredo',
      webhookStatus: 'FAILED',
      webhookAttempts: 3,
      ...overrides,
    },
  });
  createdIds.push(payment.id);
  return payment;
}

const base: Payment = {
  id: 'x', amount: new Prisma.Decimal('1'), status: 'PAID', pixPayload: 'p', qrId: null, receiptCode: null,
  transactionHash: '0xabc', idempotencyKey: null, metadata: null,
  webhookUrl: 'https://h.example.com/hook', webhookStatus: 'FAILED', webhookAttempts: 3,
  paidAt: new Date(), createdAt: new Date(), expiresAt: new Date(),
};

describe('checkResendable', () => {
  it('PAID + FAILED → pode reenviar', () => {
    expect(checkResendable(base)).toEqual({ ok: true });
  });

  it('pagamento inexistente → recusa', () => {
    expect(checkResendable(null).ok).toBe(false);
  });

  it.each(['PENDING', 'EXPIRED', 'MISROUTED'])('status %s → recusa SEMPRE, mesmo com --force', (status) => {
    const r = checkResendable({ ...base, status }, { force: true });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/não PAID/);
  });

  it('sem webhookUrl → recusa', () => {
    expect(checkResendable({ ...base, webhookUrl: null }, { force: true }).ok).toBe(false);
  });

  it('DELIVERED → recusa sem --force, aceita com --force', () => {
    expect(checkResendable({ ...base, webhookStatus: 'DELIVERED' }).ok).toBe(false);
    expect(checkResendable({ ...base, webhookStatus: 'DELIVERED' }, { force: true }).ok).toBe(true);
  });

  it('PENDING (retentativas podem estar em curso) → recusa sem --force, aceita com --force', () => {
    expect(checkResendable({ ...base, webhookStatus: 'PENDING' }).ok).toBe(false);
    expect(checkResendable({ ...base, webhookStatus: 'PENDING' }, { force: true }).ok).toBe(true);
  });
});

describe('listFailedDeliveries', () => {
  it('lista só PAID com webhook FAILED, e o destino sai sem a query string (token)', async () => {
    const alvo = await seed({});
    const entregue = await seed({ webhookStatus: 'DELIVERED' });
    const naoPago = await seed({ status: 'EXPIRED' });

    const rows = await listFailedDeliveries();
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(alvo.id);
    expect(ids).not.toContain(entregue.id);
    expect(ids).not.toContain(naoPago.id);
    const row = rows.find((r) => r.id === alvo.id)!;
    expect(row.destination).toBe('https://integrador.example.com/hook');
    expect(JSON.stringify(rows)).not.toContain('segredo');
  });
});

describe('resendWebhook', () => {
  it('PAID + FAILED: pede confirmação e entrega', async () => {
    const payment = await seed({});
    const confirm = vi.fn(async (_summary: string) => true);
    const deliver = vi.fn(async () => 'DELIVERED' as const);

    const outcome = await resendWebhook(payment.id, { confirm, deliver });

    expect(outcome).toEqual({ result: 'DELIVERED' });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: payment.id }));
    // A pergunta mostra o destino sem o token.
    expect(confirm.mock.calls[0][0]).toContain('https://integrador.example.com/hook');
    expect(confirm.mock.calls[0][0]).not.toContain('segredo');
  });

  it('confirmação negada: nada é enviado', async () => {
    const payment = await seed({});
    const deliver = vi.fn(async () => 'DELIVERED' as const);

    const outcome = await resendWebhook(payment.id, { confirm: async () => false, deliver });

    expect(outcome).toEqual({ result: 'CANCELLED' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('cobrança não paga: recusa sem perguntar e sem enviar, mesmo com --force', async () => {
    const payment = await seed({ status: 'PENDING' });
    const confirm = vi.fn(async (_summary: string) => true);
    const deliver = vi.fn(async () => 'DELIVERED' as const);

    const outcome = await resendWebhook(payment.id, { force: true, confirm, deliver });

    expect(outcome.result).toBe('REFUSED');
    expect(confirm).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('nunca muda o status do pagamento', async () => {
    const payment = await seed({});
    await resendWebhook(payment.id, { confirm: async () => true, deliver: async () => 'FAILED' });
    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe('PAID');
  });
});
