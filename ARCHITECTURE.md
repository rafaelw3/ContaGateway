# Arquitetura

O que o ContaGateway é, com que stack e qual padrão arquitetural segue. Descreve
o **estado atual**; o histórico de decisões e seus porquês está em
[`DECISIONS.md`](./DECISIONS.md).

## 1. O que é o ContaGateway

Um **gateway de pagamentos** que liga cobranças Pix ao mundo cripto: cria a
cobrança Pix via conta.vc, aguarda a liquidação on-chain (mint de **cBRL** na
rede **Base**) e libera o pagamento por webhook para o sistema cliente — tudo
automatizado, sem intervenção manual.

1. Cliente chama `POST /v1/payments` com um valor em BRL.
2. O serviço gera um QR Code Pix (via `CONTA_VC_INTENT_URL`) e devolve
   `pixPayload` + link de pagamento.
3. O usuário final paga o Pix na conta.vc.
4. A conta.vc minta **cBRL** na wallet Base configurada.
5. `Web3Listener` detecta o mint, aguarda confirmações de bloco (proteção contra
   reorg) e casa o valor com um pagamento `PENDING` — ou `EXPIRED` recente,
   dentro da janela de carência (`SETTLEMENT_GRACE_PERIOD_MS`).
6. O pagamento vira `PAID` e o webhook notifica o sistema cliente.

**cBRL é a única fonte de verdade da liquidação; BRLA nunca decide status.** Essa
é a decisão arquitetural mais importante do projeto; o porquê está no `DECISIONS.md`.

`CONTA_VC_INTENT_URL` é uma **API interna da conta.vc, sem suporte para
terceiros**. Nenhuma mudança pode
assumir estabilidade de contrato que não existe.

## 2. Stack técnica

- **Runtime**: Node.js 22 LTS (`engines`, `Dockerfile` e CI), TypeScript, ESM (`"type": "module"`)
- **HTTP**: Fastify 5
- **Validação**: JSON Schema nativo do Fastify (Ajv), `removeAdditional: false`
  (campo desconhecido devolve 400, não é descartado em silêncio),
  `allowUnionTypes: true`
- **Banco**: PostgreSQL via Prisma (`prisma/schema.prisma`: `Payment` e o checkpoint de sincronização `SyncCheckpoint`)
- **Web3**: `viem`, eventos de contrato na Base via WebSocket (`BASE_WSS_RPC_URL`)
- **Logging**: `pino`, logger único compartilhado (`src/lib/logger.ts`), com
  redação de segredos (URLs de RPC) antes de logar erros do viem
- **Rate limiting**: `@fastify/rate-limit`, global e por-rota (`config.rateLimit`)
- **QR Code**: `qrcode`, com cache TTL em memória (10 min)
- **Testes**: Vitest (230 testes em 20 arquivos em `src/lib/__tests__`,
  `src/services/__tests__`, `src/routes/__tests__`, `scripts/__tests__`)
- **Observabilidade**: Sentry (`@sentry/node`)
- **API docs**: OpenAPI 3 via `@fastify/swagger` + `swagger-ui`, gerado dos
  mesmos JSON Schemas da validação (fonte de verdade única). UI em
  `/documentation`
- **CI**: GitHub Actions (`.github/workflows/ci.yml`) — Postgres de serviço,
  `npm ci`, build, `npm run typecheck` (inclui `scripts/`, que o `tsx` roda sem
  checar tipos), testes, `npm audit`
- **Containers / deploy**: Docker multi-stage, `docker-compose.yml` para dev,
  Railway em produção

## 3. Arquitetura: camadas estritas

```
src/
├── instrument.ts   # Sentry.init() — carregado ANTES de tudo via --import, nunca importado
├── app.ts          # Monta o Fastify (schemas/hooks/rate-limit/rotas), SEM subir listener nem workers
├── server.ts       # Bootstrap: valida env, buildApp(), sobe HTTP + serviços de background
├── routes/         # Controllers finos: schema, parsing, chama service, formata resposta
├── services/       # Regra de negócio (PaymentService, Web3Listener, WebhookService, QRCodeService, ExpirationWorker)
├── lib/            # Utilitários transversais, sem regra de negócio (logger, env, guards, prisma)
└── views/          # HTML servido direto (página de checkout)
```

Princípios que qualquer mudança preserva:

1. **Rotas são controllers finos.** `routes.ts` nunca fala com o Prisma nem
   contém regra de negócio. Erro interno vai para `fastify.log.error`; a resposta
   ao cliente usa mensagem genérica, sem vazar detalhe interno.
2. **Validação na borda.** Todo body/params tem JSON Schema explícito. Nunca
   confie em `request.body` sem schema.
3. **`app.ts` monta, `server.ts` sobe.** Essa separação permite testar rotas com
   `.inject()` sem abrir porta TCP nem conexão WSS real. Não junte de volta.
4. **Services são a camada de negócio**, Prisma incluído. Concorrência via update
   atômico condicional (`updateMany` filtrando status), nunca `SELECT` + `UPDATE`.
   Nunca `as any` em service: nos dados do Prisma ele desliga a checagem de
   campos e um nome errado só estoura em runtime. O tipo `Payment` é o gerado
   pelo Prisma (reexportado por `src/lib/prisma.ts`), nunca uma interface escrita
   à mão nem `as unknown as Payment` — `typeSafety.test.ts` impede os três.
5. **`lib/` é utilitário sem estado de negócio** — logger, `assertRequiredEnv`,
   guards (SSRF, profundidade de JSON, limite de valor), leitura de BR Code Pix
   (`pixEmv.ts`), checagem de prontidão do banco (`readiness.ts`). Nunca lógica
   de pagamento.
6. **Idempotência é obrigatória em endpoint de criação de recurso financeiro**
   (header `Idempotency-Key` + coluna única + recuperação do erro `P2002`).
   Chave reenviada com **outro valor** é recusada (`IdempotencyConflictError` →
   422), nos dois caminhos — checagem inicial e recuperação do `P2002`. Nunca
   devolva em silêncio a cobrança de outro valor.
7. **Configuração é validada no boot** (`assertRequiredEnv()` em `server.ts`),
   não ignorada em silêncio em runtime. Variável obrigatória sem a qual o sistema
   não funciona fica nessa lista — nunca com valor padrão embutido no código
   (o padrão silencioso de `CONTA_VC_USERNAME` foi removido; ver `DECISIONS.md`,
   2026-09-27). O `PaymentService` também recusa instanciar sem o handle, como
   segunda barreira para quem constrói o serviço fora do `server.ts`.
8. **Logging estruturado único.** Nunca `console.log`/`console.error` em código
   novo. Erro que pode conter segredo passa por redação antes do log — mas a
   redação é **por serviço, não no logger**: `src/lib/logger.ts` é um pino puro,
   sem `redact`. Quem protege é `safeWssRpcUrl`/`redact()`/`logError()` no
   `Web3Listener` e `sanitizeUrlForLog()` no `WebhookService`. Serviço novo que
   logue um erro cru com segredo não está coberto por nada — trate a redação na
   origem.
9. **Rate limiting por rota** em endpoint custoso ou sensível, além do global.
10. **Despacho de webhooks seguro.** `WebhookService` nunca segue redirecionamentos HTTP (`maxRedirects: 0`), exige `https:` e revalida o destino contra SSRF e DNS rebinding imediatamente antes do disparo.

## 4. Modelo de dados

`Payment` cobre todo o ciclo de vida da cobrança. O único outro model é
`SyncCheckpoint` (`sync_checkpoints`): o último bloco cujos mints de cBRL já
foram processados, uma linha por contrato — é o que permite recuperar mints de
uma queda de qualquer duração.

Campos de `Payment`:

- `status`: `String` livre, não enum — de propósito, para permitir estado novo
  (como `MISROUTED`) sem migração. Hoje: `PENDING`, `PAID`, `EXPIRED`, `MISROUTED`
- `transactionHash`, `qrId`: únicos — idempotência de liquidação e de QR code
- `paidAt`: horário do bloco do mint que liquidou (quando o dinheiro chegou),
  gravado na mesma escrita atômica do `PAID`; nulo para linhas pagas antes da
  coluna existir. É o `paidAt` do webhook, igual em todo envio e reenvio
- `idempotencyKey`: único — idempotência de criação
- `@@index([status, amount])`: suporta a query mais quente (achar candidato
  `PENDING` por valor exato ao processar um mint)
- `receiptCode`: código curto legível (`K7X9-2B3F`, ver `src/lib/receiptCode.ts`),
  gerado em todo pagamento novo; nullable só para não exigir backfill

- `webhookUrl`, `webhookStatus`: infraestrutura de entrega — **nunca** vão para
  resposta de API (`webhookUrl` costuma ter token na query string)

Campos públicos vs. técnicos: ver `DECISIONS.md`. Resposta de API é
**allowlist explícita no handler** (`serializePaymentResponse`), nunca spread da
row (`{ ...payment }`) — o `response` schema do Fastify é segunda barreira, não
a única.

## 5. Como rodar, testar e implantar

```bash
npm run setup          # wizard interativo: gera .env (pede handle/wallet, gera segredos)
npm run dev            # servidor local com watch (tsx)
npm run probe:contavc  # sonda SÓ GET: o endpoint interno da conta.vc mudou? (nunca cria cobrança)
npm run webhook:resend -- --list   # PAID com webhook FAILED; `-- <id>` reenvia (só PAID, pede confirmação)
npm run reconcile      # conciliação on-chain SÓ LEITURA: mints sem cobrança e PAID sem prova (padrão: 7 dias)
npm run db:up          # Postgres local via docker-compose
npm test               # suíte Vitest (usa .env.test, nunca dados reais)
npm run test:migrate   # migrations no banco de teste
npm run build          # compila para dist/
npm run typecheck      # tsc sem emitir, src/ + scripts/ (o build só vê src/)
npm start              # roda a build compilada
```

**`npm test` precisa do Postgres de teste de pé** — `npm run db:up` antes, e
`npm run test:migrate` na primeira vez. Sem isso, os testes que tocam o banco
falham por timeout com 500 no lugar do status esperado, o que parece bug de
código e não é.

`scripts/setup.ts` só roda localmente e escreve o `.env` no disco.
Deploy e backup: seção "Backup e Restauração" do README.

## 6. Variáveis de ambiente

`.env.example` tem a lista completa e comentada. Grupos:

- **Servidor**: `PORT`, `HOST`, `LOG_LEVEL`, `TRUST_PROXY`
- **Banco**: `DATABASE_URL`
- **conta.vc**: `CONTA_VC_USERNAME`, `CONTA_VC_INTENT_URL`
- **Web3/Base**: `BASE_WSS_RPC_URL`, `RECIPIENT_WALLET_ADDRESS`,
  `WEB3_REQUIRED_CONFIRMATIONS`, `WEB3_BLOCK_TIME_MS`,
  `SETTLEMENT_GRACE_PERIOD_MS`, `WEB3_SYNC_INTERVAL_MS`,
  `WEB3_SYNC_MAX_LOOKBACK_BLOCKS`, `WEB3_SYNC_CHUNK_BLOCKS`
- **cBRL (liquidação, autoritativo)**: `CBRL_CONTRACT_ADDRESS`, `CBRL_DECIMALS`,
  `EXPECTED_CBRL_WALLET_ADDRESS` (opcional)
- **BRLA (diagnóstico, opcional)**: `BRLA_CONTRACT_ADDRESS`, `BRLA_DECIMALS`,
  `BRLA_RESERVE_ADDRESS` (vazio desativa)
- **Webhooks**: `WEBHOOK_SECRET`, `WEBHOOK_MAX_RETRIES`
- **Observabilidade**: `SENTRY_DSN`, `SENTRY_ENVIRONMENT`,
  `OPS_ALERT_WEBHOOK_URL`
- **Segurança/anti-DoS**: `API_KEY` (uma ou mais, separadas por vírgula — ver
  `src/lib/apiKeys.ts`), `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`,
  `MAX_PAYMENT_AMOUNT`, `BODY_LIMIT_BYTES`, `PAYMENT_CREATE_RATE_LIMIT_MAX`,
  `QRCODE_RATE_LIMIT_MAX`, `PAY_PAGE_RATE_LIMIT_MAX`, `WEBHOOK_RETRY_RATE_LIMIT_MAX`,
  `EXPIRATION_WORKER_INTERVAL_MS`
- **Infra/Escalabilidade**: `REDIS_URL` (opcional, para rate limit multi-instância)

