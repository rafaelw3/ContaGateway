import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import axios from 'axios';

/**
 * SEC-05: o guard assertPublicWebhookUrl() valida o destino na CRIAÇÃO do
 * pagamento, mas o axios seguia redirecionamentos no DISPATCH — um host público
 * podia responder 302 Location: http://169.254.169.254/... e o axios lia o
 * metadata da nuvem de dentro da rede privada, contornando o guard por completo.
 *
 * Estes testes provam duas coisas:
 *   1. O comportamento do axios com as opções que o WebhookService usa hoje:
 *      o redirecionamento NÃO é seguido.
 *   2. A invariante no código-fonte: a chamada de dispatch carrega
 *      maxRedirects: 0. Sem ela, o teste 1 vira ficção.
 */

const webhookServiceSource = readFileSync(
  fileURLToPath(new URL('../../services/WebhookService.ts', import.meta.url)),
  'utf8'
);

describe('WebhookService — SEC-05: despacho não segue redirecionamento', () => {
  it('axios com maxRedirects: 0 não alcança o alvo de um 302 (não lê metadata interna)', async () => {
    let targetReached = false;

    const target = http.createServer((_req, res) => {
      targetReached = true;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('INTERNAL-SECRET-DATA');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetPort = (target.address() as { port: number }).port;

    const redirector = http.createServer((_req, res) => {
      res.writeHead(302, {
        Location: `http://127.0.0.1:${targetPort}/latest/meta-data/iam/`,
      });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    const redirectorPort = (redirector.address() as { port: number }).port;

    try {
      // Mesmas opções relevantes do dispatch real em WebhookService.
      await expect(
        axios.post(`http://127.0.0.1:${redirectorPort}/webhook`, '{}', {
          headers: { 'content-type': 'application/json' },
          timeout: 10000,
          maxRedirects: 0,
          validateStatus: (status) => status >= 200 && status < 300,
        })
      ).rejects.toThrow(/302/);

      // O ponto central: o alvo interno NUNCA foi alcançado.
      expect(targetReached).toBe(false);
    } finally {
      redirector.close();
      target.close();
    }
  });

  it('o dispatch de webhook declara maxRedirects: 0 (invariante no código-fonte)', () => {
    expect(webhookServiceSource).toMatch(/maxRedirects:\s*0/);
  });

  it('o dispatch exige https antes de enviar', () => {
    // O WebhookService rejeita protocolo diferente de https: no caminho de entrega.
    expect(webhookServiceSource).toMatch(/!==\s*'https:'/);
  });

  it('o dispatch revalida o destino (assertPublicWebhookUrl) imediatamente antes do envio', () => {
    expect(webhookServiceSource).toMatch(/await assertPublicWebhookUrl\(/);
  });

  it('nunca loga a URL de webhook crua (query pode conter token secreto)', () => {
    // Regressão: a URL comentada no payload de log deve ser sempre a versão
    // sanitizada, nunca `webhookUrl` direto numa interpolação de template.
    const rawUrlInLog = /\$\{webhookUrl\}/.test(webhookServiceSource);
    expect(rawUrlInLog).toBe(false);
  });
});

describe('WebhookService.deliverPaymentPaid — desfecho aguardável (usado pelo reenvio manual)', () => {
  // IP literal público: passa no guard anti-SSRF sem depender de DNS. O envio
  // em si é interceptado (axios.post), então nada sai da máquina.
  const createdIds: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    const { prisma } = await import('../../lib/prisma.js');
    await prisma.payment.deleteMany({ where: { id: { in: createdIds } } });
    createdIds.length = 0;
  });

  async function seedPaid() {
    const { prisma } = await import('../../lib/prisma.js');
    const p = await prisma.payment.create({
      data: {
        amount: '5.00',
        status: 'PAID',
        pixPayload: 'dummy-deliver',
        expiresAt: new Date(Date.now() + 60_000),
        webhookUrl: 'https://8.8.8.8/hook',
        webhookStatus: 'FAILED',
      },
    });
    createdIds.push(p.id);
    return p;
  }

  it('devolve DELIVERED e grava webhookStatus quando o integrador responde 2xx', async () => {
    const { WebhookService } = await import('../WebhookService.js');
    const { prisma } = await import('../../lib/prisma.js');
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200 } as never);
    const payment = await seedPaid();

    const result = await new WebhookService().deliverPaymentPaid(payment as never);

    expect(result).toBe('DELIVERED');
    expect(post).toHaveBeenCalledOnce();
    expect((await prisma.payment.findUnique({ where: { id: payment.id } }))?.webhookStatus).toBe('DELIVERED');
  });

  // O Decimal do Prisma serializa 5.00 como "5": sem formatação explícita, o
  // integrador recebia "5" e exibia "R$ 5". amountCents é a unidade da conta.vc.
  it('o payload leva amount com 2 casas e amountCents em centavos inteiros', async () => {
    const { WebhookService } = await import('../WebhookService.js');
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200 } as never);
    const payment = await seedPaid();

    await new WebhookService().deliverPaymentPaid(payment as never);

    // O corpo vai como string JSON (é o mesmo byte-a-byte que assina o HMAC).
    const payload = JSON.parse(post.mock.calls[0][1] as string) as {
      data: { amount: string; amountCents: number };
    };
    expect(payload.data.amount).toBe('5.00');
    expect(payload.data.amountCents).toBe(500);
  });

  it('o payload leva o paidAt gravado na liquidação (o mesmo em qualquer reenvio), não a hora do envio', async () => {
    const { WebhookService } = await import('../WebhookService.js');
    const { prisma } = await import('../../lib/prisma.js');
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200 } as never);
    const payment = await seedPaid();
    const paidAt = new Date('2026-09-01T12:34:56.000Z');
    await prisma.payment.update({ where: { id: payment.id }, data: { paidAt } });
    const withPaidAt = await prisma.payment.findUnique({ where: { id: payment.id } });

    await new WebhookService().deliverPaymentPaid(withPaidAt as never);

    const body = JSON.parse(post.mock.calls[0][1] as string);
    expect(body.data.paidAt).toBe('2026-09-01T12:34:56.000Z');
  });

  it('devolve FAILED e grava webhookStatus quando todas as tentativas falham', async () => {
    const { WebhookService } = await import('../WebhookService.js');
    const { prisma } = await import('../../lib/prisma.js');
    vi.spyOn(axios, 'post').mockRejectedValue(new Error('ECONNREFUSED'));
    const payment = await seedPaid();

    const original = process.env.WEBHOOK_MAX_RETRIES;
    process.env.WEBHOOK_MAX_RETRIES = '1';
    try {
      const result = await new WebhookService().deliverPaymentPaid(payment as never);
      expect(result).toBe('FAILED');
    } finally {
      if (original === undefined) delete process.env.WEBHOOK_MAX_RETRIES;
      else process.env.WEBHOOK_MAX_RETRIES = original;
    }
    expect((await prisma.payment.findUnique({ where: { id: payment.id } }))?.webhookStatus).toBe('FAILED');
  });
});

describe('WebhookService.markInterruptedDeliveriesAsFailed — entregas órfãs de um reinício', () => {
  const ids: string[] = [];
  afterEach(async () => {
    const { prisma } = await import('../../lib/prisma.js');
    await prisma.payment.deleteMany({ where: { id: { in: ids } } });
    ids.length = 0;
  });

  async function seed(status: string, webhookStatus: string, webhookUrl: string | null = 'https://8.8.8.8/hook') {
    const { prisma } = await import('../../lib/prisma.js');
    const p = await prisma.payment.create({
      data: { amount: '9.00', status, pixPayload: 'orfa', expiresAt: new Date(Date.now() + 60_000), webhookUrl, webhookStatus },
    });
    ids.push(p.id);
    return p.id;
  }

  it('PAID com entrega PENDING vira FAILED; o resto fica como estava', async () => {
    const { WebhookService } = await import('../WebhookService.js');
    const { prisma } = await import('../../lib/prisma.js');
    const orfa = await seed('PAID', 'PENDING');
    const entregue = await seed('PAID', 'DELIVERED');
    const naoPaga = await seed('PENDING', 'PENDING');
    const semUrl = await seed('PAID', 'PENDING', null);

    await new WebhookService().markInterruptedDeliveriesAsFailed();

    const status = async (id: string) => (await prisma.payment.findUnique({ where: { id } }))!.webhookStatus;
    expect(await status(orfa)).toBe('FAILED');
    expect(await status(entregue)).toBe('DELIVERED');
    expect(await status(naoPaga)).toBe('PENDING');
    expect(await status(semUrl)).toBe('PENDING');
  });
});

