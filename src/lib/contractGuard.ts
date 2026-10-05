import * as Sentry from '@sentry/node';
import axios from 'axios';
import { logger } from './logger.js';

/**
 * Erro específico para quando a resposta da conta.vc (endpoint interno, sem
 * suporte oficial — ver ARCHITECTURE.md seção 1) sai do formato que o código
 * espera. Ter uma classe própria (em vez de `Error` genérico) permite
 * distinguir "mudança de contrato deles" de qualquer outra falha ao ler
 * logs/Sentry, e é o gatilho para uma eventual regra de alerta.
 */
export class ContaVcContractDriftError extends Error {
  constructor(message: string, public readonly details: Record<string, unknown>) {
    super(message);
    this.name = 'ContaVcContractDriftError';
  }
}

const alertWebhookUrls = (process.env.OPS_ALERT_WEBHOOK_URL || '')
  .split(',')
  .map((url) => url.trim())
  .filter((url) => url.length > 0);

/**
 * Canal de alerta em camadas, para funcionar independente de onde o
 * ContaGateway estiver rodando (local, VPS, Railway, com ou sem Sentry):
 *
 * 1. Log estruturado (sempre) — funciona em qualquer lugar que colete stdout,
 *    sem nenhuma configuração adicional.
 * 2. Sentry (se `SENTRY_DSN` estiver configurado) — mesmo padrão de "vazio
 *    desativa sem quebrar nada" já usado em `instrument.ts`.
 * 3. Webhook(s) genérico(s) (se `OPS_ALERT_WEBHOOK_URL` estiver configurado)
 *    — para quem não usa Sentry ainda receber um push ativo (Slack, Discord,
 *    um workflow n8n via node "Webhook" etc.), sem depender de alguém estar
 *    olhando os logs. Aceita uma ou mais URLs separadas por vírgula, para
 *    disparar em vários destinos ao mesmo tempo (ex: Slack + n8n).
 *
 * Nunca lança exceção — uma falha ao alertar não pode derrubar o fluxo de
 * pagamento que está sendo protegido.
 */
export function reportContractDrift(context: string, details: Record<string, unknown>): void {
  logger.error(
    { event: 'contavc_contract_drift', context, details },
    `[ALERTA] Resposta da conta.vc fora do formato esperado em "${context}" — possível mudança não anunciada no endpoint interno (ver ARCHITECTURE.md seção 1).`
  );

  try {
    Sentry.captureMessage(`conta.vc contract drift: ${context}`, {
      level: 'error',
      extra: details,
    });
  } catch {
    // Sentry nunca deve poder quebrar o fluxo de alerta em si.
  }

  if (alertWebhookUrls.length > 0) {
    const summary = `⚠️ ContaGateway: possível mudança no endpoint da conta.vc (${context}). Detalhes: ${JSON.stringify(details).slice(0, 500)}`;
    // Enviamos "text" (Slack) e "content" (Discord) no mesmo payload — cada
    // serviço usa a chave que reconhece e ignora a outra; um destino genérico
    // (ex: webhook trigger do n8n) recebe o JSON cru e decide o que fazer.
    // Cada URL falha de forma independente — uma não deve impedir as outras.
    for (const url of alertWebhookUrls) {
      axios.post(url, { text: summary, content: summary }, { timeout: 5000 }).catch((err) => {
        logger.warn({ err, url }, '[contractGuard] Falha ao notificar um destino de OPS_ALERT_WEBHOOK_URL');
      });
    }
  }
}
