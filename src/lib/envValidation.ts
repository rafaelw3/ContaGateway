import { logger } from './logger.js';
import { parseApiKeys } from './apiKeys.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Detecta configurações que hoje falham em silêncio: a app sobe normalmente,
 * mas uma função central (liquidação on-chain, autenticação) nunca vai
 * funcionar de verdade. Em produção isso vira erro fatal (falha rápido); fora
 * de produção só avisa, para não travar quem está testando só uma parte do
 * fluxo (ex: geração de Pix sem se importar com o lado on-chain ainda).
 */
export function assertRequiredEnv(): void {
  const isProduction = process.env.NODE_ENV === 'production';
  const warnings: string[] = [];
  const productionErrors: string[] = [];

  const recipient = (process.env.RECIPIENT_WALLET_ADDRESS || '').toLowerCase();
  if (!recipient || recipient === ZERO_ADDRESS) {
    const msg =
      'RECIPIENT_WALLET_ADDRESS não está configurado (ou está no endereço zero) — ' +
      'nenhuma transferência on-chain será reconhecida como pagamento.';
    (isProduction ? productionErrors : warnings).push(msg);
  }

  if (!process.env.CONTA_VC_USERNAME || !process.env.CONTA_VC_USERNAME.trim()) {
    const msg =
      'CONTA_VC_USERNAME não está definido — o serviço não consegue criar cobranças Pix ' +
      '(é o handle da conta.vc que recebe os pagamentos).';
    // Sem handle configurado, nenhuma cobrança pode ser criada: erro fatal em
    // produção, aviso fora dela.
    (isProduction ? productionErrors : warnings).push(msg);
  }

  if (parseApiKeys(process.env.API_KEY).length === 0) {
    const msg = process.env.API_KEY
      ? 'API_KEY está definida mas não contém nenhuma chave (ex: só vírgulas) — as rotas administrativas vão recusar tudo.'
      : 'API_KEY não está definida — as rotas administrativas ficarão sem autenticação.';
    (isProduction ? productionErrors : warnings).push(msg);
  }

  if (!process.env.DATABASE_URL) {
    // Sempre erro fatal, mesmo fora de produção: sem banco a app não faz nada.
    productionErrors.push('DATABASE_URL não está configurado.');
  }

  for (const warning of warnings) {
    logger.warn(`[Config] ${warning}`);
  }

  if (productionErrors.length > 0) {
    throw new Error(
      '❌ Configuração inválida — o servidor NÃO vai iniciar até isso ser corrigido no .env:\n' +
      productionErrors.map((error) => `  - ${error}`).join('\n') +
      '\n\nEdite o .env com os valores corretos e reinicie (ex: "docker compose up -d" novamente).' +
      ' Veja o README, seção "Como Iniciar", para o que cada variável significa.'
    );
  }
}
