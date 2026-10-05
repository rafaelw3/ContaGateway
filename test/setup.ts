import { config, parse } from 'dotenv';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const devEnvPath = path.join(rootDir, '.env');
const testEnvPath = path.join(rootDir, '.env.test');

// O cliente gerado do Prisma carrega o `.env` da raiz do projeto para
// process.env no momento em que é importado. Importamos ele aqui, de
// propósito (pelo mesmo caminho que a aplicação usa, src/lib/prisma.ts, para
// não gerar um segundo módulo que recarregaria o .env), ANTES de montar o
// ambiente de teste: assim esse efeito colateral
// acontece agora e pode ser desfeito logo abaixo, em vez de injetar a
// configuração real de desenvolvimento no meio da suíte.
await import('../src/lib/prisma.js');

// Remove tudo que veio só do `.env` de desenvolvimento (conta.vc real,
// carteira real, BRLA_RESERVE_ADDRESS...). Sem isto os testes mudam de
// comportamento conforme o .env da máquina — um mesmo commit passa aqui e
// falha no CI, ou vice-versa.
if (existsSync(devEnvPath) && existsSync(testEnvPath)) {
  const devKeys = Object.keys(parse(readFileSync(devEnvPath)));
  const testKeys = new Set(Object.keys(parse(readFileSync(testEnvPath))));
  for (const key of devKeys) {
    if (!testKeys.has(key)) delete process.env[key];
  }
}

// Carrega .env.test antes de qualquer módulo da aplicação ser importado pelos
// testes — vários services leem process.env no top-level/construtor
// (ex: WebhookService exige WEBHOOK_SECRET presente). `override` garante que o
// valor de teste vence o que o .env de desenvolvimento já tiver definido.
config({ path: testEnvPath, override: true });
