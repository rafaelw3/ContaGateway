#!/usr/bin/env -S npx tsx
/**
 * Reenvio manual do webhook `payment.paid` — a ferramenta que faltava para a
 * decisão ARC-01 (DECISIONS.md, 2026-09-27): quando as retentativas se
 * esgotam, a cobrança fica PAID com `webhookStatus = FAILED` e "cabe ao
 * operador efetuar o reenvio manual". Roda localmente, com o `.env` do
 * ambiente que se quer operar (mesmo banco, mesmo WEBHOOK_SECRET):
 *
 *   npm run webhook:resend -- --list             # PAID com entrega FAILED
 *   npm run webhook:resend -- <paymentId>        # reenvia (pede confirmação)
 *   npm run webhook:resend -- <paymentId> --yes  # sem pergunta (uso em script)
 *   npm run webhook:resend -- <paymentId> --force  # também DELIVERED/PENDING
 *
 * Nunca muda o `status` do pagamento — só tenta a entrega de novo, pelo mesmo
 * WebhookService do servidor (https obrigatório, revalidação anti-SSRF, sem
 * seguir redirect, assinatura HMAC). Não é endpoint HTTP de propósito: um
 * "reenviar webhook" exposto na rede seria um jeito de disparar notificações
 * de pagamento sob demanda.
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { prisma, type Payment } from '../src/lib/prisma.js';
import { webhookService, WebhookService } from '../src/services/WebhookService.js';

export type ResendCheck = { ok: true } | { ok: false; reason: string };

/**
 * Decide se um pagamento pode ter o webhook reenviado. `status !== 'PAID'`
 * é recusa absoluta, mesmo com --force: `payment.paid` para uma cobrança não
 * paga faria o integrador liberar algo que ninguém pagou.
 */
export function checkResendable(payment: Payment | null, opts: { force?: boolean } = {}): ResendCheck {
  if (!payment) {
    return { ok: false, reason: 'pagamento não encontrado.' };
  }
  if (payment.status !== 'PAID') {
    return {
      ok: false,
      reason: `status é ${payment.status}, não PAID. O webhook anuncia "pagamento confirmado" — nunca é reenviado para cobrança não paga, nem com --force.`,
    };
  }
  if (!payment.webhookUrl) {
    return { ok: false, reason: 'o pagamento não tem webhookUrl — não há para onde reenviar.' };
  }
  if (payment.webhookStatus === 'DELIVERED' && !opts.force) {
    return {
      ok: false,
      reason: `webhook já foi entregue (${payment.webhookAttempts} tentativa(s)). Só reenvie se o integrador confirmar que não processou — aí use --force.`,
    };
  }
  if (payment.webhookStatus === 'PENDING' && !opts.force) {
    return {
      ok: false,
      reason:
        'entrega está PENDING: as retentativas ainda estão rodando no servidor (as de antes de um reinício viram FAILED sozinhas na subida). Só use --force se tiver certeza de que nenhuma instância está entregando.',
    };
  }
  return { ok: true };
}

export interface FailedDelivery {
  id: string;
  amount: string;
  createdAt: Date;
  webhookAttempts: number;
  destination: string;
}

/** Pagamentos PAID cuja entrega esgotou as retentativas. Destino sem query string. */
export async function listFailedDeliveries(): Promise<FailedDelivery[]> {
  const rows = await prisma.payment.findMany({
    where: { status: 'PAID', webhookStatus: 'FAILED' },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((p) => ({
    id: p.id,
    amount: p.amount.toString(),
    createdAt: p.createdAt,
    webhookAttempts: p.webhookAttempts,
    destination: WebhookService.sanitizeUrlForLog(p.webhookUrl ?? ''),
  }));
}

export type ResendOutcome =
  | { result: 'DELIVERED' | 'FAILED' }
  | { result: 'REFUSED'; reason: string }
  | { result: 'CANCELLED' };

export async function resendWebhook(
  paymentId: string,
  opts: {
    force?: boolean;
    confirm: (summary: string) => Promise<boolean>;
    deliver?: (payment: Payment) => Promise<'DELIVERED' | 'FAILED'>;
  }
): Promise<ResendOutcome> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  const check = checkResendable(payment, { force: opts.force });
  if (!check.ok) {
    return { result: 'REFUSED', reason: check.reason };
  }

  const p = payment!;
  const summary =
    `Reenviar payment.paid do pagamento ${p.id} (R$ ${p.amount.toString()}, webhook ${p.webhookStatus ?? 'sem status'}) ` +
    `para ${WebhookService.sanitizeUrlForLog(p.webhookUrl!)}?`;
  if (!(await opts.confirm(summary))) {
    return { result: 'CANCELLED' };
  }

  const deliver = opts.deliver ?? ((payment: Payment) => webhookService.deliverPaymentPaid(payment));
  return { result: await deliver(p) };
}

async function promptConfirm(summary: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${summary}\nDigite "sim" para confirmar: `);
    return answer.trim().toLowerCase() === 'sim';
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    const rows = await listFailedDeliveries();
    if (rows.length === 0) {
      console.log('Nenhum pagamento PAID com entrega de webhook FAILED.');
      return 0;
    }
    console.log(`${rows.length} pagamento(s) PAID com webhook FAILED:\n`);
    for (const r of rows) {
      console.log(`  ${r.id}  R$ ${r.amount}  ${r.createdAt.toISOString()}  ${r.webhookAttempts} tentativa(s)  → ${r.destination}`);
    }
    console.log('\nPara reenviar: npm run webhook:resend -- <id>');
    return 0;
  }

  const paymentId = args.find((a) => !a.startsWith('--'));
  if (!paymentId) {
    console.error('Uso: npm run webhook:resend -- --list | <paymentId> [--yes] [--force]');
    return 2;
  }

  const outcome = await resendWebhook(paymentId, {
    force: args.includes('--force'),
    confirm: args.includes('--yes') ? async () => true : promptConfirm,
  });

  switch (outcome.result) {
    case 'DELIVERED':
      console.log('✅ Webhook entregue. webhookStatus = DELIVERED.');
      return 0;
    case 'FAILED':
      console.error('❌ Entrega falhou de novo em todas as tentativas. webhookStatus = FAILED. Veja o log acima para o motivo.');
      return 1;
    case 'REFUSED':
      console.error(`Recusado: ${outcome.reason}`);
      return 2;
    case 'CANCELLED':
      console.log('Cancelado. Nada foi enviado.');
      return 0;
  }
}

// Só executa quando rodado diretamente, nunca quando importado pelos testes.
const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('Erro inesperado no reenvio:', err);
      process.exitCode = 2;
    })
    .finally(() => prisma.$disconnect());
}
