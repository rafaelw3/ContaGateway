import crypto from 'crypto';
import axios from 'axios';
import * as Sentry from '@sentry/node';
import { prisma, type Payment } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { assertPublicWebhookUrl } from '../lib/webhookSecurity.js';
import { formatCentsAsAmount, centsFromStoredAmount } from '../lib/paymentValidation.js';

export class WebhookService {
  private readonly secret: string;
  private readonly maxRetries: number;

  constructor() {
    // Sem um segredo explícito, todo deploy sem WEBHOOK_SECRET configurado
    // compartilharia o mesmo HMAC público — um atacante poderia forjar
    // X-Signature válido para webhooks falsos de "pagamento confirmado".
    if (!process.env.WEBHOOK_SECRET) {
      throw new Error(
        'WEBHOOK_SECRET não configurado. Defina uma chave secreta única no .env antes de iniciar o servidor.'
      );
    }
    this.secret = process.env.WEBHOOK_SECRET;
    this.maxRetries = Number(process.env.WEBHOOK_MAX_RETRIES) || 3;
  }

  /**
   * Dispara o webhook de forma assíncrona (não-bloqueante)
   */
  notifyPaymentPaid(payment: Payment): void {
    if (!payment.webhookUrl) {
      return;
    }

    // Executa em segundo plano para não travar o loop de eventos
    void this.deliverPaymentPaid(payment).catch((err) => {
      logger.error(
        { err, paymentId: payment.id },
        `[WebhookService] Erro fatal não tratado ao despachar webhook para pagamento ${payment.id}`
      );
    });
  }

  /**
   * Reduz uma URL de webhook a origem + caminho, sem query string. A query é o
   * lugar onde integradores costumam colocar token secreto
   * (`?token=...`), então nunca vai para o log. O path é preservado porque é o
   * que o operador precisa para identificar o destino durante um incidente.
   */
  static sanitizeUrlForLog(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return '<url inválida>';
    }
  }

  /**
   * Na subida do servidor: entregas `PENDING` de pagamentos PAID são órfãs —
   * as retentativas vivem em memória e morreram com o processo anterior.
   * Viram FAILED para aparecerem em `npm run webhook:resend -- --list` em vez
   * de ficarem presas para sempre. O updateMany condicionado a PENDING nunca
   * sobrescreve um DELIVERED; se uma instância antiga ainda estiver terminando
   * a entrega (troca de versão), o DELIVERED dela, escrito depois, prevalece.
   */
  async markInterruptedDeliveriesAsFailed(): Promise<number> {
    const result = await prisma.payment.updateMany({
      where: { status: 'PAID', webhookStatus: 'PENDING', webhookUrl: { not: null } },
      data: { webhookStatus: 'FAILED' },
    });
    if (result.count > 0) {
      logger.warn(
        { event: 'webhook_orphans_found', count: result.count },
        `[WebhookService] ${result.count} entrega(s) de webhook interrompida(s) pelo reinício marcada(s) como FAILED. ` +
          'Reenvie com: npm run webhook:resend -- --list'
      );

      try {
        Sentry.captureMessage(`WebhookService: ${result.count} webhook(s) órfão(s) marcado(s) como FAILED no boot`, {
          level: 'warning',
          extra: { count: result.count },
        });
      } catch {
        // Sentry nunca deve quebrar o fluxo de boot.
      }
    }
    return result.count;
  }

  /**
   * Entrega o evento `payment.paid` com retentativas e devolve o desfecho,
   * gravado também em `webhookStatus`. O fluxo normal usa `notifyPaymentPaid`
   * (sem esperar); este método é público para o reenvio manual do operador
   * (`scripts/resend-webhook.ts`), que precisa saber se a entrega deu certo.
   */
  async deliverPaymentPaid(payment: Payment): Promise<'DELIVERED' | 'FAILED'> {
    const webhookUrl = payment.webhookUrl!;
    const safeUrl = WebhookService.sanitizeUrlForLog(webhookUrl);
    let metadataParsed: unknown = null;

    if (payment.metadata) {
      if (typeof payment.metadata === 'string') {
        try {
          metadataParsed = JSON.parse(payment.metadata);
        } catch {
          metadataParsed = payment.metadata;
        }
      } else {
        metadataParsed = payment.metadata;
      }
    }

    // Mesmo contrato de valor da API REST: `amount` sempre com 2 casas e
    // `amountCents` em centavos inteiros (a unidade da conta.vc). Sem o
    // formato fixo, o Decimal do Prisma entregaria "1" para R$ 1,00.
    const amountCents = centsFromStoredAmount(payment.amount);

    const payload = {
      event: 'payment.paid',
      timestamp: Date.now(),
      data: {
        id: payment.id,
        amount: formatCentsAsAmount(amountCents),
        amountCents,
        status: payment.status,
        // receiptCode é seguro para mostrar ao pagador final do integrador;
        // transactionHash é dado técnico para auditoria interna do integrador
        // — nunca deveria ser repassado ao cliente final dele.
        receiptCode: payment.receiptCode,
        transactionHash: payment.transactionHash,
        metadata: metadataParsed,
        createdAt: payment.createdAt,
        // Horário do bloco do mint, gravado na liquidação — o mesmo em toda
        // tentativa e em todo reenvio. Só cai no "agora" para linha paga antes
        // de a coluna existir.
        paidAt: (payment.paidAt ?? new Date()).toISOString(),
      },
    };

    const payloadString = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', this.secret).update(payloadString).digest('hex');

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'ContaGateway-Webhook/1.0',
      'X-Signature': signature,
      'X-Timestamp': String(payload.timestamp),
    };

    // Persiste a intenção de entrega no banco antes do loop de retentativas.
    // webhookStatus é um campo tipado do model Payment — sem cast para any,
    // um nome de campo errado falha na compilação (ver typeSafety.test.ts).
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        webhookStatus: 'PENDING',
      },
    });

    let delivered = false;
    let attempt = 0;

    while (!delivered && attempt < this.maxRetries) {
      attempt++;
      try {
        const parsedUrl = new URL(webhookUrl);
        if (parsedUrl.protocol !== 'https:') {
          throw new Error(`Protocolo não permitido para entrega de webhook: ${parsedUrl.protocol}. Apenas https é aceito.`);
        }

        await assertPublicWebhookUrl(webhookUrl);

        logger.info(`[WebhookService] Enviando webhook para ${safeUrl} (tentativa ${attempt}/${this.maxRetries})...`);

        const response = await axios.post(webhookUrl, payloadString, {
          headers,
          timeout: 10000,
          maxRedirects: 0,
          validateStatus: (status) => status >= 200 && status < 300,
        });

        logger.info(`[WebhookService] ✅ Webhook entregue com sucesso! Status HTTP ${response.status}`);
        delivered = true;

        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            webhookStatus: 'DELIVERED',
            webhookAttempts: attempt,
          },
        });
      } catch (err) {
        const error = err as Error;
        logger.warn(`[WebhookService] Falha na tentativa ${attempt} ao entregar webhook para ${safeUrl}: ${error.message}`);

        if (attempt < this.maxRetries) {
          // Backoff exponencial: 2s, 5s, etc.
          const delay = attempt * 2500;
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          // Recuperação automática não existe por decisão explícita de arquitetura (ARC-01):
          // nenhum worker de recuperação ou cron roda em segundo plano para retentar webhooks FAILED.
          // Cobranças com webhookStatus = 'FAILED' exigem reenvio manual pelo operador
          // (scripts/resend-webhook.ts).
          logger.error(
            `[WebhookService] ❌ Número máximo de tentativas atingido para o pagamento ${payment.id} (valor: ${payment.amount}). O pagamento está PAID on-chain mas NÃO FOI ENTREGUE ao integrador. Requer reenvio manual pelo operador: npm run webhook:resend -- ${payment.id}`
          );

          try {
            Sentry.captureMessage(`WebhookService: entrega falhou após ${this.maxRetries} tentativas`, {
              level: 'error',
              extra: { paymentId: payment.id, amount: payment.amount, safeUrl },
            });
          } catch {
            // Sentry nunca deve quebrar o loop.
          }
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              webhookStatus: 'FAILED',
              webhookAttempts: attempt,
            },
          });
        }
      }
    }

    return delivered ? 'DELIVERED' : 'FAILED';
  }
}

export const webhookService = new WebhookService();
