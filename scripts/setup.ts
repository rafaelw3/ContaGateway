#!/usr/bin/env -S npx tsx
/**
 * Wizard interativo de configuração — roda uma vez, localmente, e escreve o
 * `.env`. Não é uma API/console exposto na rede de propósito: as duas
 * variáveis mais sensíveis daqui (RECIPIENT_WALLET_ADDRESS, CONTA_VC_USERNAME)
 * decidem pra onde vai a liquidação de todo pagamento — reconfigurá-las exige
 * acesso ao filesystem do servidor, nunca uma chamada HTTP.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(rootDir, '.env');
const envExamplePath = join(rootDir, '.env.example');

export const WALLET_PATTERN = /^0x[a-fA-F0-9]{40}$/;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function isValidWallet(address: string): boolean {
  return WALLET_PATTERN.test(address) && address.toLowerCase() !== ZERO_ADDRESS;
}

export function generateSecret(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('hex')}`;
}

/**
 * Substitui (ou adiciona, se ainda não existir) uma variável no conteúdo de
 * um .env, preservando todo o resto do template intacto (comentários,
 * ordem, outras variáveis).
 */
export function setVar(template: string, key: string, value: string): string {
  const line = `${key}="${value}"`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(template)) {
    return template.replace(pattern, line);
  }
  return `${template}\n${line}\n`;
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string) => rl.question(question);

  console.log('\n⚡ ContaGateway — configuração inicial\n');
  console.log('Isso escreve/atualiza o seu .env local. Nada é enviado pela rede.\n');

  if (existsSync(envPath)) {
    const overwrite = await ask('Já existe um .env neste diretório. Sobrescrever? (s/N): ');
    if (overwrite.trim().toLowerCase() !== 's') {
      console.log('\nCancelado. Nenhum arquivo foi alterado.');
      rl.close();
      return;
    }
  }

  if (!existsSync(envExamplePath)) {
    console.error('\n❌ .env.example não encontrado — rode este script na raiz do projeto.');
    rl.close();
    process.exitCode = 1;
    return;
  }

  let template = readFileSync(envExamplePath, 'utf-8');

  // 1. Handle da conta.vc (obrigatório)
  let username = '';
  while (!username) {
    username = (await ask('Handle da sua conta.vc (o que aparece em app.conta.vc/pay/SEU_HANDLE): ')).trim();
    if (!username) console.log('  → obrigatório, não pode ficar em branco.');
  }
  template = setVar(template, 'CONTA_VC_USERNAME', username);

  // 2. Carteira Base (obrigatória, valida formato)
  let wallet = '';
  while (!isValidWallet(wallet)) {
    wallet = (await ask('Endereço da sua carteira na Base (0x..., Configurações > Segurança na conta.vc): ')).trim();
    if (!WALLET_PATTERN.test(wallet)) {
      console.log('  → precisa ser um endereço Ethereum válido: 0x seguido de 40 caracteres hexadecimais.');
    } else if (wallet.toLowerCase() === ZERO_ADDRESS) {
      console.log('  → não pode ser o endereço zero.');
    }
  }
  template = setVar(template, 'RECIPIENT_WALLET_ADDRESS', wallet);

  // 3. Segredos — gera automaticamente em vez de pedir pro usuário inventar
  const apiKey = generateSecret('cgw_live');
  const webhookSecret = generateSecret('cgw_sec');
  template = setVar(template, 'API_KEY', apiKey);
  template = setVar(template, 'WEBHOOK_SECRET', webhookSecret);

  // 4. Sentry (opcional)
  const sentryDsn = (await ask('DSN do Sentry (opcional, Enter para pular): ')).trim();
  if (sentryDsn) {
    template = setVar(template, 'SENTRY_DSN', sentryDsn);
  }

  writeFileSync(envPath, template, 'utf-8');
  rl.close();

  console.log('\n✅ .env criado/atualizado com sucesso.\n');
  console.log('Resumo do que foi configurado automaticamente:');
  console.log(`  - CONTA_VC_USERNAME=${username}`);
  console.log(`  - RECIPIENT_WALLET_ADDRESS=${wallet}`);
  console.log(`  - API_KEY=${apiKey}  (guarde — é o que você usa no header X-API-Key)`);
  console.log(`  - WEBHOOK_SECRET=${webhookSecret}  (guarde — valida a assinatura dos webhooks)`);
  console.log('\nPróximo passo:');
  console.log('  docker compose up -d --build');
  console.log('  docker compose logs -f app   # confirme que subiu sem erro de configuração\n');
}

// Só executa o wizard quando o arquivo é rodado diretamente (`npm run setup`),
// nunca quando importado (ex: pelos testes unitários das funções acima).
const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('\n❌ Erro inesperado no wizard de setup:', err);
    process.exitCode = 1;
  });
}
