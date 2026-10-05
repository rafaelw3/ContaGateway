import { describe, it, expect, afterEach, vi } from 'vitest';
import { PaymentService, IdempotencyConflictError } from '../PaymentService.js';
import { prisma } from '../../lib/prisma.js';
import { ContaVcContractDriftError } from '../../lib/contractGuard.js';
import * as contractGuard from '../../lib/contractGuard.js';
import { buildPixEmv } from './fixtures/contaVcFake.js';

// CONTA_VC_INTENT_URL em .env.test aponta para um endereço inalcançável de
// propósito: se a dedupe por idempotencyKey falhar e o código tentar mesmo
// assim chamar o provedor, o teste falha com um erro de rede em vez de
// silenciosamente "passar".
const paymentService = new PaymentService();
const createdIds: string[] = [];

afterEach(async () => {
  if (createdIds.length > 0) {
    await prisma.payment.deleteMany({ where: { id: { in: createdIds } } });
    createdIds.length = 0;
  }
});

describe('PaymentService — CONTA_VC_USERNAME é obrigatório', () => {
  const originalUsername = process.env.CONTA_VC_USERNAME;

  afterEach(() => {
    if (originalUsername === undefined) {
      delete process.env.CONTA_VC_USERNAME;
    } else {
      process.env.CONTA_VC_USERNAME = originalUsername;
    }
  });

  it('recusa instanciar quando CONTA_VC_USERNAME está ausente', () => {
    delete process.env.CONTA_VC_USERNAME;

    // Sem handle configurado o serviço não pode existir: antes havia um fallback
    // silencioso para um handle literal, que fazia o boot passar e as cobranças
    // irem para a conta errada sem nenhum sinal.
    expect(() => new PaymentService()).toThrow(/CONTA_VC_USERNAME/);
  });

  it('recusa instanciar quando CONTA_VC_USERNAME é só espaços em branco', () => {
    process.env.CONTA_VC_USERNAME = '   ';

    expect(() => new PaymentService()).toThrow(/CONTA_VC_USERNAME/);
  });

  it('instancia normalmente quando CONTA_VC_USERNAME está configurado', () => {
    process.env.CONTA_VC_USERNAME = 'handle_configurado';

    expect(() => new PaymentService()).not.toThrow();
  });
});

describe('PaymentService.createPayment — idempotência', () => {
  it('reaproveita o pagamento existente para a mesma idempotencyKey, sem chamar o provedor', async () => {
    const idempotencyKey = `test-idem-${Date.now()}-${Math.random()}`;
    const future = new Date(Date.now() + 15 * 60 * 1000);

    const existing = await prisma.payment.create({
      data: {
        amount: '42.00',
        status: 'PENDING',
        pixPayload: 'dummy-existing-payload',
        idempotencyKey,
        expiresAt: future,
      },
    });
    createdIds.push(existing.id);

    const result = await paymentService.createPayment({ amount: 42, idempotencyKey });

    expect(result.id).toBe(existing.id);
  });

  it('mesma idempotencyKey com valor diferente → IdempotencyConflictError, sem chamar o provedor', async () => {
    const idempotencyKey = `test-idem-conflict-${Date.now()}-${Math.random()}`;
    const existing = await prisma.payment.create({
      data: {
        amount: '10.00',
        status: 'PENDING',
        pixPayload: 'dummy-existing-payload',
        idempotencyKey,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    createdIds.push(existing.id);

    // Se a checagem falhasse e o código seguisse para o provedor, o erro seria
    // de rede (URL inalcançável do .env.test), não IdempotencyConflictError.
    await expect(paymentService.createPayment({ amount: 50, idempotencyKey })).rejects.toThrow(IdempotencyConflictError);
    // Nenhuma cobrança nova foi gravada com essa chave.
    expect(await prisma.payment.count({ where: { idempotencyKey } })).toBe(1);
  });

  it('valor equivalente em outra representação ("42.0", 42, 4200 centavos) não conta como conflito', async () => {
    const idempotencyKey = `test-idem-equiv-${Date.now()}-${Math.random()}`;
    const existing = await prisma.payment.create({
      data: {
        amount: '42.00',
        status: 'PENDING',
        pixPayload: 'dummy-existing-payload',
        idempotencyKey,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    createdIds.push(existing.id);

    expect((await paymentService.createPayment({ amount: '42.0', idempotencyKey })).id).toBe(existing.id);
    expect((await paymentService.createPayment({ amount: 42, idempotencyKey })).id).toBe(existing.id);
    // Mesmo valor pela unidade canônica da conta.vc.
    expect((await paymentService.createPayment({ amountCents: 4200, idempotencyKey })).id).toBe(existing.id);
  });

  // Antes, 42.001 era arredondado para 4200 centavos e passava como "mesmo
  // valor". Precisão sub-centavo agora é recusada na entrada, então nem chega
  // à comparação de idempotência.
  it('precisão sub-centavo é recusada, não arredondada para o valor existente', async () => {
    const idempotencyKey = `test-idem-subcent-${Date.now()}-${Math.random()}`;
    const existing = await prisma.payment.create({
      data: {
        amount: '42.00',
        status: 'PENDING',
        pixPayload: 'dummy-existing-payload-subcent',
        idempotencyKey,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    createdIds.push(existing.id);

    await expect(paymentService.createPayment({ amount: 42.001, idempotencyKey })).rejects.toThrow(/2 casas decimais/);
    // 10.555 arredondava PARA CIMA: cobrava R$ 10,56 de quem pediu R$ 10,555.
    await expect(paymentService.createPayment({ amount: '10.555' })).rejects.toThrow(/2 casas decimais/);
    // E um valor sub-centavo virava cobrança de zero no provedor.
    await expect(paymentService.createPayment({ amount: '0.001' })).rejects.toThrow(/inválido/);
  });

  it('rejeita amount inválido antes de qualquer acesso ao banco ou rede', async () => {
    await expect(paymentService.createPayment({ amount: 'não-é-numero' })).rejects.toThrow(/inválido/);
  });

  it('sem idempotencyKey, tenta chamar o provedor de verdade (falha de rede esperada aqui)', async () => {
    // Confirma que o caminho "normal" (sem dedupe) realmente tenta a chamada
    // externa - a URL inalcançável do .env.test garante que isso nunca cria
    // uma cobrança real durante os testes.
    await expect(paymentService.createPayment({ amount: 15 })).rejects.toThrow();
  });
});

describe('PaymentService — validação de contrato da resposta da conta.vc', () => {
  // CONTA_VC_INTENT_URL é um endpoint interno sem suporte oficial (ver
  // ARCHITECTURE.md seção 1) — estes testes garantem que uma mudança de formato na
  // resposta é detectada e alertada, em vez de silenciosamente aceita ou de
  // gerar um erro genérico difícil de diagnosticar.
  const validate = (data: unknown, sentAmountCents: number) =>
    (paymentService as unknown as {
      validateIntentResponse: (d: unknown, a: number) => { qrId: string; emv: string; amountCents: number; expiresAt: string };
    }).validateIntentResponse(data, sentAmountCents);

  it('aceita uma resposta no formato esperado', () => {
    const future = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const result = validate({ qrId: 'abc', emv: buildPixEmv(100), amountCents: 100, expiresAt: future }, 100);
    expect(result.qrId).toBe('abc');
    expect(result.amountCents).toBe(100);
  });

  it('lança ContaVcContractDriftError quando o EMV está ausente', () => {
    expect(() => validate({ qrId: 'abc', expiresAt: new Date().toISOString() }, 100)).toThrow(ContaVcContractDriftError);
  });

  it('lança ContaVcContractDriftError quando o qrId está ausente', () => {
    const future = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    expect(() => validate({ emv: buildPixEmv(100), expiresAt: future }, 100)).toThrow(/qrId/);
  });

  it('lança ContaVcContractDriftError quando expiresAt não é parseável', () => {
    expect(() => validate({ qrId: 'abc', emv: buildPixEmv(100), expiresAt: 'não-é-data' }, 100)).toThrow(
      /expiresAt/
    );
  });

  it('não lança, mas reporta drift, quando amountCents diverge do valor enviado', () => {
    const reportSpy = vi.spyOn(contractGuard, 'reportContractDrift').mockImplementation(() => undefined);
    const future = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    expect(() => validate({ qrId: 'abc', emv: buildPixEmv(100), amountCents: 999, expiresAt: future }, 100)).not.toThrow();
    expect(reportSpy).toHaveBeenCalledWith(
      'createPayment.amountCents_mismatch',
      expect.objectContaining({ sentAmountCents: 100, receivedAmountCents: 999 })
    );

    reportSpy.mockRestore();
  });
});
