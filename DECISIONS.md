# DECISIONS.md

Log curto e cronológico de decisões de engenharia que têm um "porquê" não óbvio pelo código — não é um changelog (isso é o `git log`), não é a arquitetura atual (isso é o `ARCHITECTURE.md`). Cada entrada é intencionalmente curta; detalhe completo fica no README ou no commit referenciado.

Regra de uso: só registrar aqui decisões cujo raciocínio seria caro de reconstruir do zero — não documentar mudanças rotineiras.

---

## 2026-09-15 — cBRL, não BRLA, decide a liquidação

Um mint de cBRL foi parar em carteira errada enquanto o BRLA (lastro) seguiu normal pra reserva compartilhada — usar BRLA como sinal de liquidação gera falso positivo. Ver README "Por que cBRL e não BRLA?" e `ARCHITECTURE.md` seção 1.

## 2026-09-15 — Migração de SQLite para PostgreSQL

Stress test mostrou 56% de falha em 25 chamadas concorrentes no SQLite (timeout de transação interativa). Zero falhas no Postgres no mesmo teste.

## 2026-09-15 — `TRUST_PROXY` explícito, não confiança cega em `X-Forwarded-*`

Cabeçalhos forjáveis por qualquer chamador direto sem essa opção — permitiria phishing via QR Code apontando pra host controlado pelo atacante.

## 2026-09-16 — Sentry para observabilidade, não só logs estruturados

Erros e performance precisam de rastreamento correlacionado, não só `pino` local. `SENTRY_DSN` vazio desativa sem quebrar nada.

## 2026-09-16 — Grace period de 30 min na liquidação (`SETTLEMENT_GRACE_PERIOD_MS`)

Pix pago nos últimos segundos antes do QR expirar pode ter o mint de cBRL confirmado minutos depois — sem isso, a cobrança fica presa como `EXPIRED` mesmo com o dinheiro tendo chegado. Candidato `PENDING` genuíno sempre tem prioridade sobre `EXPIRED`-em-carência do mesmo valor.

## 2026-09-16 — `npm run setup` (wizard local), não um endpoint de configuração via REST

Cogitado expor configuração de wallet/handle via API REST autenticada para facilitar integração de outros serviços. Rejeitado: seria o vetor de ataque mais valioso contra o próprio sistema (redirecionar liquidações). Configuração de identidade de deploy é 12-factor (env var), nunca recurso de negócio exposto por HTTP.

## 2026-09-16 — `receiptCode` público substitui `transactionHash` em superfícies do pagador final

Página de checkout e webhook expunham hash on-chain e link pro BaseScan diretamente ao pagador — vazamento de abstração (ele não precisa saber que existe blockchain). Nova coluna `receiptCode`, curta e legível, é o único campo seguro para superfícies públicas. Contrato de integração formalizado (resposta de API é allowlist explícita, ver `ARCHITECTURE.md` seção 4), pensado para qualquer serviço que se conectar.

## 2026-09-16 — Mantido `WEB3_REQUIRED_CONFIRMATIONS=3` (não reduzido)

Reduzir para 1 confirmação cortaria ~4s de latência percebida, trocando por uma margem menor de segurança contra reorg. Decisão consciente: manter 3.

## 2026-09-16 — Mantido timeout de 15s na chamada à conta.vc (não aumentado)

Um timeout real foi investigado e a causa foi lentidão pontual da conta.vc, não um padrão sistemático. Aumentar o timeout foi considerado e descartado — não há sinal de que seja necessário ainda.

## 2026-09-16 — `Web3Listener` continua sem filtro por carteira de destino (`to`)

Cogitado filtrar a subscription do contrato cBRL só pelos mints que já chegam na nossa carteira, por escalabilidade. Rejeitado: filtrar por `to` tornaria o sistema estruturalmente cego a exatamente o tipo de desvio que já causou o incidente original (seção acima). Custo de processar mints de terceiros é uma query Postgres indexada — desprezível na escala atual.

## 2026-09-17 — Causa raiz da conta.vc confirmada: `/api/pay/intent` é API interna sem suporte

O suporte técnico da conta.vc confirmou diretamente que o endpoint que usamos é interno, sem garantia de estabilidade pra terceiros, e que uma API oficial com KYC está a caminho. Isso encerra a incerteza que motivou toda a arquitetura de `MISROUTED`/validação híbrida — deixa de ser mitigação temporária pra um bug deles e passa a ser parte permanente do design, já que a instabilidade é estrutural (endpoint nunca foi feito pra isso), não um bug pontual corrigível. Migrar pra API oficial deles, quando sair, é candidato a redesenho do `PaymentService`, não prioridade imediata.

## 2026-09-17 — Detecção de mudança de contrato via validação de resposta, não canário sintético

Considerado um teste diário automatizado (POST real de baixo valor, nunca pago) contra `/api/pay/intent` pra detectar mudança de contrato antes de um cliente real ser afetado. Rejeitado: exigiria uma exceção permanente à regra de nunca fazer POST real sem confirmação explícita, e contradiria a promessa recém-documentada no README de não gerar tráfego além do necessário contra os servidores da conta.vc.

Adotado em vez disso: validação estrita de todo campo da resposta real (`PaymentService.validateIntentResponse`) com alerta em três camadas independentes (`src/lib/contractGuard.ts`) — log estruturado sempre, Sentry se configurado, webhook genérico (`OPS_ALERT_WEBHOOK_URL`) se configurado. Nenhuma camada depende de configuração externa pra funcionar minimamente — importante porque `SENTRY_DSN` é opcional, e quem faz deploy próprio (VPS, outro Railway) pode não configurá-lo. Detecção passa a ser "no primeiro uso real", não preventiva — aceitável porque essa etapa não envolve custódia de fundos (só criação de QR), então o risco de uma resposta mal formada é falha visível, não dinheiro perdido.

## 2026-09-17 — Backup do Postgres: script portátil pronto, ativação deixada pra quem opera o deploy

Confirmado via API (`volumeInstanceBackupScheduleUpdate`/`volumeInstanceBackupScheduleList` retornam "Not Authorized") que o backup nativo de volume da Railway exige plano Pro — a suposição do README estava certa. GitHub Actions foi descartado como mecanismo de agendamento: só alcançaria o Postgres se ele estivesse exposto publicamente, piora de segurança real e impossível numa VPS/local atrás de NAT.

Construído em vez disso `scripts/backup-postgres.sh`: `pg_dump` (formato custom) + `rclone` (config só por env var, qualquer destino S3-compatível) + retenção configurável. Testado localmente contra o Postgres do `docker compose` (incluindo um bug real corrigido: `DATABASE_URL` do Prisma tem `?schema=public`, que o `pg_dump`/libpq não entende — precisa ser removido antes de usar). `postgresql-client`, `rclone` e `bash` adicionados à imagem Docker.

Decisão explícita de **não** ir além disso nesta sessão: ativar de verdade exigiria criar uma conta/bucket num provedor de storage e configurar credenciais reais — o usuário preferiu não compartilhar segredos de produção pelo chat (risco real de exposição em histórico de conversa, e de custo caso a credencial vazasse) e apontou que o valor real está em o ContaGateway continuar rodando bem em qualquer plataforma, não em eu mesmo terminar de ativar uma integração externa específica. Script fica pronto, documentado e testado; ativação é passo manual de quem opera o deploy, feito fora desta sessão.

## 2026-09-21 — Leitura completa (11/11 páginas) confirma casamento por valor exato, resolve tensão aparente

Segunda rodada, lendo as 11 páginas inteiras de `docs.conta.vc` (não só as 5 da primeira passada). Achado que parecia risco real: a doc do on-ramp diz que a descoberta on-chain busca por **faixa de valor**, não valor exato, porque a taxa da Conta é deduzida do BRLA entregue — o `Web3Listener.ts` (`settleTransfer`/`flagMisroutedCbrl`) casa por `amount: formattedAmount`, valor exato.

Resolvido, não é bug: `docs.conta.vc/docs/dolares` confirma que a taxa da Conta só é cobrada **quando configurada** pro fluxo. Pix→cBRL já é confirmado grátis (usuário, duas vezes) — sem taxa configurada, sem desconto, o mint bate exato com o Pix pago. O próprio incidente real de wallet errada (15/09) só foi detectado porque o `flagMisroutedCbrl` (mesma lógica de valor exato) encontrou o candidato certo — evidência de que o valor bate exato na prática, não só em teoria. Comentário explicativo adicionado no código (`Web3Listener.ts`, antes da query de `settleTransfer`) citando a fonte, com aviso: se a conta.vc um dia configurar taxa nesse fluxo específico, o sintoma visível é o warning "Nenhuma cobrança PENDING/dentro da carência encontrada" disparando em volume. Suíte de testes (81 testes) rodada depois da mudança — só comentário, nada de lógica alterada, todos passam.

Outros achados da leitura completa, sem ação de código necessária: princípio de arquitetura deles ("falha visível", estados ambíguos nunca fazem retry silencioso) é convergência independente com nosso design `MISROUTED`. Nenhuma menção a `/api/pay/intent`, cBRL, KYC ou CNPJ em nenhuma das 11 páginas — confirma (não assume) que a integração continua não documentada oficialmente. Achados de produto novos (money links, P2P auto-roteado sem taxa, risco de perda de passkey do usuário sem suporte de recuperação) registrados fora deste repositório — são estratégia/produto, não arquitetura deste repositório.

## 2026-09-21 — Documentação oficial da conta.vc (docs.conta.vc) consultada e cruzada contra nosso entendimento

Achado que parecia contradição grave (doc oficial nunca menciona "cBRL", só "BRLA", descrito com as propriedades que atribuímos ao cBRL) resolvido via verificação direta no BaseScan, não por suposição: `CBRL_CONTRACT_ADDRESS` é o token próprio da conta.vc ("contaBRL"), `BRLA_CONTRACT_ADDRESS` é um token de **outra empresa** (Avenia/Ada Capital). Não são dois nomes do mesmo ativo — a doc oficial usa "BRLA" de forma genérica/categórica, o BRLA da Avenia é o lastro/reserva que a conta.vc mantém, cBRL é o que emitem pro cliente. Não invalida a decisão de 15/09 — reforça, com fonte primária em vez de só observação empírica de um incidente. Ver `ARCHITECTURE.md` seção 1.

Duas confirmações independentes adicionais: a doc oficial confirma webhook entregue "exatamente uma vez, sem retentativa" (`/docs/rails/reconciliacao`) — justifica por que o `Web3Listener` não pode depender só de webhook, já é o design atual. E o QR Pix tem janela de descoberta tardia de +30min documentada oficialmente (`/docs/rails/onramp`) — bate quase exato com nosso `SETTLEMENT_GRACE_PERIOD_MS=30min`, escolhido antes de conhecer esse número; boa validação independente de que o valor está certo.

Achado a reconciliar, não resolvido ainda: a doc documenta slippage padrão de 0,5% no swap on-chain + menciona que existe "taxa da Conta" adicional sem valor — nossa faixa empírica de 2%-2,5% provavelmente é a soma dos dois componentes, não só slippage.

## 2026-09-17 — Auto-deploy Railway via GitHub, configurado do lado da plataforma

`railway up` manual exigia lembrar de rodar o comando após todo push relevante. Conectado o serviço `app` ao repositório GitHub via `railway service source connect --repo rafaelw3/ContaGateway --branch master` (a conta foi renomeada da conta antiga para `rafaelw3` depois desta decisão; o comando original citava a conta antiga) — feito inteiramente na configuração do projeto Railway (exigiu autorizar o GitHub App do Railway a acessar o repositório privado antes, passo manual único). Deliberadamente **não** implementado como um workflow do GitHub Actions commitado no repositório: isso manteria o repositório livre de qualquer automação específica de uma plataforma, coerente com "nada aqui está preso a um provedor específico" (ver README "Opções de Deploy"). Quem hospeda em VPS/outro PaaS não vê nem é afetado por essa conexão.

## 2026-09-27 — Allowlist de autenticação por pathname parseado, não URL bruta

Matching por `request.url.includes()` avaliava a querystring inteira, permitindo bypass de autenticação em rotas protegidas ao injetar sufixos públicos como query parameter (ex: `POST /v1/payments?x=/status`). A verificação passa a extrair estritamente o pathname parseado (sem query string ou fragmento) e validar formatos exatos ancorados via regex. As sub-rotas `/pay/:id`, `/v1/payments/:id/qrcode` e `/v1/payments/:id/status` permanecem públicas e sem chave porque são consumidas diretamente pelo navegador do pagador final na tela de checkout, onde injetar segredos do integrador seria inviável e inseguro.

## 2026-09-27 — Remoção do destinatário Pix (`username`) do payload de criação

O campo opcional `username` no body de `POST /v1/payments` permitia que um cliente/atacante direcionasse cobranças Pix na conta.vc para uma conta arbitrária de terceiro enquanto o pagador final transferia fundos reais. O destinatário da liquidação é configuração estrita de infraestrutura/deploy (`CONTA_VC_USERNAME`), nunca recurso de negócio parametrizável via API.

**Resolvido (2026-09-27, mesmo dia):** o fallback `process.env.CONTA_VC_USERNAME || '<handle>'` foi removido. O `PaymentService` agora resolve o handle no construtor e **recusa instanciar** se a variável estiver ausente ou em branco (`src/services/PaymentService.ts`), e `CONTA_VC_USERNAME` entrou em `assertRequiredEnv()` — em produção o boot falha; fora dela, avisa. Antes, com a env ausente o boot passava e toda cobrança era creditada no handle `<handle>` (o handle de teste do mantenedor) sem nenhum sinal: falha silenciosa, não desvio de fundos. O risco crescia se o código fosse auto-hospedado por terceiro ou o handle mudasse — o fallback passaria a creditar num handle que não é de quem roda, sem erro. Coberto por 3 testes em `PaymentService.test.ts` (ausente, só espaços, configurado), verificados por reversão.

## 2026-09-27 — Despacho de webhook seguro contra SSRF (redirecionamento e DNS rebinding) e durabilidade mínima

Embora `assertPublicWebhookUrl` validasse a URL no momento da criação do pagamento, o axios por padrão segue redirecionamentos HTTP (`302 Location: http://169.254.169.254/...`), permitindo que um endpoint controlado pelo integrador/atacante contornasse a validação inicial para ler metadados em rede interna. Além disso, a re-resolução de DNS no momento do despacho abria janela para DNS rebinding. O `WebhookService` agora:
1. Exige estritamente o protocolo `https:` para o destino de entrega;
2. Re-executa `assertPublicWebhookUrl(webhookUrl)` imediatamente antes do envio, dentro do bloco de tentativa;
3. Configura `maxRedirects: 0` no axios para que redirecionamentos nunca sejam seguidos. Recusas por validação ou redirecionamento são tratadas como falhas de entrega dentro do loop de retentativas, sem quebrar o loop e nunca marcando a entrega como bem-sucedida.

Quanto à durabilidade da notificação (ARC-01):
- A intenção de entrega é persistida no banco com `webhookStatus: 'PENDING'` antes do início das retentativas, permitindo diferenciar cobranças em processamento daquelas nunca enfileiradas.
- O disparo em segundo plano é monitorado com `.catch()` em `notifyPaymentPaid`, eliminando rejeições não tratadas.
- Quando as retentativas se esgotam, a cobrança é mantida como `FAILED`. Por decisão explícita de manter a arquitetura enxuta e sem complexidade de agendamento, **não foi adicionado worker de recuperação nem job recorrente**. A falha é registrada com log de erro contendo o ID e o valor do pagamento, alertando que a cobrança está `PAID` on-chain mas não foi entregue; cabe ao operador identificar essas falhas e efetuar o reenvio manual ao integrador.

Redação de log (achado DOC-03): a URL de destino nunca é interpolada crua nas mensagens do `WebhookService`; o log usa `sanitizeUrlForLog()` (origem + path, sem query), porque integradores costumam carregar um token secreto na query string (`?token=...`). Nota relacionada: `ARCHITECTURE.md` §3.8 descreve a redação de segredos como se vivesse no logger compartilhado, mas `src/lib/logger.ts` não define `redact` — a proteção real é pontual, por serviço (`safeWssRpcUrl`/`redact()`/`logError()` em `Web3Listener`, e agora `sanitizeUrlForLog()` aqui). Qualquer serviço novo que logue um objeto de erro cru contendo segredo não está coberto por ela.

## 2026-09-27 — `logger.ts` continua pino puro; redação de segredo é por serviço (fecha DOC-03)

Decisão consciente de **não** adicionar `redact` global ao logger compartilhado, encerrando o achado DOC-03.

Achado original: `ARCHITECTURE.md` §3.8 descrevia a redação de segredos como se vivesse no logger, mas `src/lib/logger.ts` é um pino puro sem `redact`. Isso já foi corrigido na documentação — a seção agora diz explicitamente que a proteção é **por serviço**, não no logger.

O que foi decidido agora é o **código**: manter assim. Motivos:
- Um `redact` global por lista de paths (`*.webhookUrl`, `*.rpcUrl`, `req.headers.authorization`) só cobre segredos **conhecidos e nomeados**. Segredo que chega dentro de uma string livre — a URL com token na query de um erro do axios, o caso real do `WebhookService` — não está em path nenhum e passaria batido. Falsa sensação de cobertura.
- A proteção pontual é **mais estreita e mais correta**: `safeWssRpcUrl`/`redact()`/`logError()` no `Web3Listener` conhecem o segredo concreto (a URL de RPC configurada) e o apagam por valor, não por nome de campo. `sanitizeUrlForLog()` no `WebhookService` corta a query inteira justamente porque não sabe qual parâmetro carrega o token.
- Adicionar `redact` agora sem testar cada serviço trocaria uma lacuna conhecida e documentada por uma cobertura parcial não verificada.

Regra que fica: **serviço novo que logue erro cru contendo segredo não está coberto por nada — trate a redação na origem.** Se um dia o logger ganhar `redact`, que seja com teste por serviço provando que o segredo concreto some, não por conveniência.

## 2026-09-28 — Drift da conta.vc: validação do BR Code + sonda só-GET, ainda sem canário

Pedido: "testar se o endpoint interno da conta.vc mudou". A decisão de 17/09 (sem canário com POST real) continua de pé; o que mudou foi cobrir a mesma pergunta por três caminhos que não criam cobrança:

1. **Validação do `emv` como BR Code** (`src/lib/pixEmv.ts`). Antes, qualquer string não vazia passava. Agora CRC16, conta `br.gov.bcb.pix` e valor do campo 54 são conferidos; `expiresAt` vencido também bloqueia. Motivo de bloquear em vez de só alertar: um Pix com CRC errado é recusado pelo banco do pagador, e um Pix com valor diferente do pedido faz o pagador pagar algo que o `Web3Listener` (casamento por valor exato) nunca liquida. CRC ancorado no exemplo oficial do manual do BCB (`1D3D`), não só em fixture própria.
2. **Teste de contrato offline** com uma conta.vc falsa em `127.0.0.1` — o que enviamos e nove formas de drift na resposta. Cada correção nova foi verificada revertendo o código e vendo o teste falhar.
3. **Sonda manual só-`GET`** (`npm run probe:contavc`): página pública de checkout, bundle JS dela e `GET <intent>/<qrId inexistente>`. É compatível com a decisão de 17/09 porque não cria cobrança, não roda em CI nem agendada, e faz no máximo ~40 requisições a recursos que qualquer navegador baixa. Limite honesto: não prova que o `POST` continua igual. Não foi possível rodá-la contra a conta.vc real na sessão que a criou (rede do ambiente bloqueia o host); 403/429 são tratados como "bloqueado", nunca como drift, justamente porque foi o que essa execução devolveu.

Achado corrigido junto: `getIntentStatus` usava URL fixa `https://app.conta.vc/api/pay/intent/<qrId>`, ignorando `CONTA_VC_INTENT_URL`. O `.env.test` inalcançável protegia a criação mas não a consulta — um teste que exercitasse a validação híbrida do `Web3Listener` faria `GET` real na conta.vc. Agora deriva de `CONTA_VC_INTENT_URL`.

Também nesta rodada: `webhookUrl` passa a exigir `https` já na criação (antes `http` era aceito e só falhava no disparo, depois do pagamento confirmado, sem o integrador saber); comparação da `X-API-Key` em tempo constante.

## 2026-09-29 — `Idempotency-Key` reenviada com outro valor responde 422; só o valor é comparado

Antes, reenviar uma `Idempotency-Key` já usada devolvia a cobrança existente **qualquer que fosse o `amount` do reenvio**. Um integrador que reaproveitasse a chave por engano (R$ 50 com a chave de uma cobrança de R$ 10) recebia `201` com o QR de R$ 10, sem sinal nenhum — e mostraria ao pagador um valor diferente do que pretendia cobrar.

Agora o `PaymentService` lança `IdempotencyConflictError` e a rota responde `422`, nos dois caminhos: a checagem inicial e a recuperação do `P2002` (corrida entre duas requisições com a mesma chave). O segundo caminho tem teste próprio: o servidor falso da conta.vc grava a cobrança "vencedora" enquanto a nossa espera a resposta.

**Só o valor é comparado, de propósito.** O padrão do mercado (Stripe) compara todos os parâmetros, mas aqui isso recusaria retentativas legítimas de integradores que regeneram `metadata`/`message` a cada tentativa (timestamp, id de rastreio) — e um retry recusado depois de um timeout de rede é justamente o cenário que a chave existe para proteger. O valor é o único campo que decide quanto o pagador paga e o que o `Web3Listener` casa por valor exato. `webhookUrl` diferente num reenvio também é ignorado (a original vale); candidato a comparação futura se aparecer caso real.

Comparação em centavos inteiros (`Math.round(x * 100)`), igual à que gera o `amountCents` enviado à conta.vc — `"42.0"`, `42` e `42.001` são o mesmo valor, coerente com o que de fato seria cobrado.

## 2026-09-29 — `/health/ready` separado; `/health` do Railway continua sem checar o banco

`/health` só dizia que o processo HTTP estava de pé — e o README o descrevia como "healthcheck da aplicação e dependências", o que era falso (corrigido em 28/09). Faltava um jeito de perguntar "o serviço consegue atender?".

Adicionado `GET /health/ready`: `SELECT 1` no Postgres com prazo de 2s (conexão pendurada não rejeita, só nunca responde — sem prazo, o check penduraria junto), `200 ready` ou `503 not_ready`. Público como `/health`, então a resposta só traz `ok`/`error`/`timeout`; a mensagem do Prisma (que pode ter host e usuário do banco) vai só para o log.

**O `healthcheckPath` do Railway continua em `/health`, de propósito.** Apontá-lo para o readiness faria um soluço do banco reiniciar o container em loop e reprovar deploy sem bug de código — reiniciar a app não conserta um Postgres fora. Liveness decide "reinicia o processo?", readiness decide "alerta alguém?"; são perguntas diferentes.

Fica de fora, por ora: o estado do WebSocket do `Web3Listener`. Ele vive em `server.ts`, não em `app.ts` (a separação que permite testar rotas sem WSS real), e expô-lo exigiria injetar o listener na montagem da app. Candidato se a queda silenciosa do RPC virar problema real.

## 2026-09-29 — Reenvio manual de webhook vira ferramenta (`npm run webhook:resend`), não endpoint

A decisão ARC-01 (27/09) disse que, esgotadas as retentativas, "cabe ao operador identificar essas falhas e efetuar o reenvio manual" — mas não havia ferramenta para isso. O único jeito era montar o payload e a assinatura HMAC à mão, o que na prática significa não reenviar.

`scripts/resend-webhook.ts` fecha esse buraco sem mudar a decisão (continua sem worker nem job recorrente): lista os `PAID` com `webhookStatus = FAILED` e reenvia um por vez, pelo mesmo `WebhookService` do servidor — que ganhou `deliverPaymentPaid()` público e aguardável, devolvendo `DELIVERED`/`FAILED`; o fluxo normal (`notifyPaymentPaid`, sem esperar) não mudou.

Regras e porquês:
- **Só `PAID`, sem exceção.** `--force` não libera status diferente: um `payment.paid` para cobrança não paga faz o integrador liberar produto que ninguém pagou. É o equivalente, do lado do integrador, a marcar `PAID` sem confirmação on-chain.
- **`DELIVERED` e `PENDING` exigem `--force`.** O primeiro duplicaria uma entrega já feita; o segundo pode ser retentativa ainda em curso em memória.
- **Confirmação interativa** por padrão, e a URL mostrada nunca inclui a query string (onde o integrador costuma pôr token).
- **CLI local, não endpoint HTTP** — mesma lógica do `npm run setup` (16/09): um "reenviar webhook" exposto na rede seria um disparador de notificações de pagamento sob demanda.

Limite conhecido, não resolvido aqui: o `paidAt` do payload é calculado na hora do envio, então no reenvio ele é a hora do reenvio, não a da liquidação. O banco não guarda a hora da liquidação; resolver exige coluna nova (`paidAt`) e migração. Documentado no README para o integrador não confiar nesse campo num reenvio.

## 2026-09-29 — Node 22 LTS; `scripts/` passa a ter type-check no CI

**Node 20 → 22.** O Node 20 saiu de suporte em 30/04/2026 — sem correção de segurança desde então — e era o runtime do `Dockerfile` (as duas etapas) e do CI. Subido para 22 LTS nos dois, com `engines: >=22` no `package.json` e `@types/node` 22 (via `npm install`, lockfile regenerado pela ferramenta). Não troquei para 24 porque 22 é a LTS com mais estrada e basta para sair do EOL; subir de novo é uma linha.

**Type-check de `scripts/`.** O `tsconfig.json` só inclui `src/` (é o que vira `dist/`), e os scripts operacionais (`setup`, `probe:contavc`, `webhook:resend`) rodam via `tsx`, que **não checa tipos**. Um erro de tipo ali só aparecia quando alguém rodasse o script — em geral no meio de um incidente, que é quando o `webhook:resend` é usado. `tsconfig.scripts.json` (estende o principal, `noEmit`) e `npm run typecheck` fecham isso; o CI roda depois do build. Na primeira execução já achou um erro real num teste do PR #4 (`vi.fn` sem parâmetro tipando `mock.calls` como vazio).

## 2026-09-29 — Liquidação medida no horário do bloco do mint; checkpoint substitui a janela fixa de 600 blocos

Dois defeitos que só aparecem juntos, numa queda do serviço:

1. **A varredura na subida olhava só os últimos 600 blocos (~20min)**, qualquer que fosse o tempo fora do ar. Um Pix pago durante uma queda maior nunca era visto.
2. **O prazo da cobrança era comparado com `now`**, não com quando o mint aconteceu. Mesmo que a varredura reencontrasse o mint, depois de uma queda maior que a carência (30min) a cobrança já estava "fora do prazo" em relação a agora e não casava — com o dinheiro tendo chegado a tempo.

Corrigir só o (1) não resolveria nada; por isso os dois vão juntos.

**Referência de tempo = horário do bloco do mint** (`getBlock`, com cache). Elegível: `PENDING`/`EXPIRED`, `createdAt <= mintTime` e `expiresAt > mintTime - carência`; prioridade para quem estava no prazo normal. O `createdAt` fecha o risco que a varredura longa amplia: um mint antigo casar com uma cobrança de mesmo valor criada depois dele. O mesmo vale para `flagMisroutedCbrl`, que agora também considera `EXPIRED` (depois de uma queda o worker já expirou a cobrança; o desvio continua sendo desvio) e nunca marca `MISROUTED` uma cobrança criada depois do mint. Sem horário do bloco (RPC fora), o mint não é liquidado no chute — conta como falha e a varredura refaz.

**Checkpoint persistido** (`sync_checkpoints`, segundo model do schema — o `Payment` continua único para a cobrança). Subida, reconexão e um timer de 1 min varrem de `checkpoint + 1` até `head - confirmações`, em lotes de 2.000 blocos (RPCs limitam o intervalo do `getLogs`). Só blocos confirmados, para que o fim do lote signifique trabalho feito — os mais novos seguem com o watcher ao vivo e seus timers de confirmação. O checkpoint só avança se nenhum mint do lote falhou (contador `processingFailures`, incrementado em todo `catch` do caminho de liquidação); reprocessar é seguro porque `transactionHash` é único. A varredura periódica tem um segundo ganho: pega eventos que uma assinatura WebSocket deixe de entregar sem erro.

Limite de volta: `WEB3_SYNC_MAX_LOOKBACK_BLOCKS` (~7 dias). Além disso, varre só o fim e loga `web3_sync_gap` com o intervalo não varrido — que precisa de conciliação on-chain.

Custo aceito: o mesmo mint pode ser processado pelo watcher e pela varredura, gerando log em dobro. Comportamento de liquidação idêntico por causa da unicidade de `transactionHash` (coberto pelos testes de idempotência que já existiam).

## 2026-09-29 — Conciliação on-chain como script só leitura (`npm run reconcile`)

O checkpoint recupera mints de uma queda, mas não cobre tudo: um buraco maior que o limite de varredura, um pagamento feito depois da carência, ou um `PAID` gravado por engano. Faltava um jeito de perguntar à blockchain "o banco bate com o que chegou?".

`scripts/reconcile.ts` faz as duas conferências: (1) mints de cBRL para a wallet de liquidação sem pagamento ligado ao `transactionHash`, com as cobranças candidatas (mesmo valor, `createdAt <=` horário do mint — o mesmo critério da liquidação); (2) `PAID` do período cujo recibo não contém um mint de cBRL para a wallet certa no valor da cobrança, ou que não existe ou foi revertido.

**Só leitura, de propósito.** Liquidar a partir do relatório seria marcar `PAID` sem confirmação humana, mesmo com a evidência na mão; a ferramenta entrega a evidência, a decisão continua com uma pessoa olhando o BaseScan. Pela mesma razão, é script local e não endpoint.

Filtro de `to` no `getLogs`: aqui é certo filtrar pela wallet, ao contrário do `Web3Listener` (decisão de 16/09), porque a pergunta da conciliação é "o que chegou para nós?". Desvios para outra wallet são detectados pelo listener (`MISROUTED`), não por esta ferramenta.

## 2026-09-29 — Coluna `paidAt` (horário do mint) e entregas de webhook órfãs viram `FAILED` na subida

Fecha os dois limites deixados abertos pelo `webhook:resend` (entrada de hoje, acima).

**`paidAt`.** O payload do webhook calculava `paidAt` na hora do envio — num reenvio, a hora do reenvio. Nova coluna `payments.paidAt`, gravada **na mesma escrita atômica do `PAID`** (`tryClaimCandidate`), com o horário do bloco do mint: quando o dinheiro chegou, não quando o gateway processou (coerente com a referência de tempo da liquidação). O webhook usa o valor gravado — igual no envio original, nas retentativas e em qualquer reenvio — e o `GET /v1/payments/:id` passa a expô-lo. Linhas pagas antes da coluna ficam com `null` (sem backfill: a hora real não existe no banco; o webhook cai no "agora" só para elas). `MISROUTED` não grava `paidAt`: desvio não é pagamento.

**Entregas órfãs.** As retentativas de webhook vivem em memória; um reinício no meio deixava o pagamento `PAID` com `webhookStatus = PENDING` para sempre — nem entregue, nem na lista de `FAILED` do reenvio. Na subida, `server.ts` chama `markInterruptedDeliveriesAsFailed()` antes de ligar o listener. Sem critério de idade, de propósito: o `updateMany` é condicionado a `PENDING`, então nunca sobrescreve `DELIVERED`; numa troca de versão com duas instâncias sobrepostas, se a antiga terminar a entrega depois, o `DELIVERED` dela prevalece. Continua sem worker de reenvio automático (ARC-01).

## 2026-09-29 — `API_KEY` aceita várias chaves; lista vazia falha fechada

Trocar a `API_KEY` exigia uma janela em que integradores com a chave antiga levavam `401` — ou trocar todos ao mesmo tempo que o deploy. Agora `API_KEY` aceita uma lista separada por vírgula (`"nova,antiga"`): adiciona a nova, migra os integradores, remove a antiga. Compatível com o formato de uma chave só. Escolhida a mesma variável, e não uma `API_KEYS` nova, para não haver duas fontes de verdade sobre quem pode chamar a API.

A comparação continua em tempo constante e passa por **todas** as chaves sem parar na primeira que casa, para o tempo de resposta não revelar a posição da chave na lista.

**Lista vazia falha fechada.** Com o parsing, `API_KEY=","` viraria "nenhuma chave". O código antigo tratava chave ausente como "sem autenticação" (fora de produção); se a lista vazia caísse no mesmo caminho, uma vírgula perdida desligaria a autenticação. Agora só a variável **ausente** desliga (e o boot de produção recusa isso); definida sem nenhuma chave útil, toda requisição leva `401` e `assertRequiredEnv` recusa o boot em produção.

## 2026-09-29 — `/health/ready` passa a checar o RPC da Base, sem acoplar `app.ts` ao listener

Fecha o candidato deixado na entrada do `/health/ready` (mesma data, acima). O gateway sem RPC não liquida nada, e isso não aparecia em lugar nenhum: um WebSocket que para de entregar eventos não gera erro, só silêncio.

**Sinal:** a última vez que o RPC respondeu numa varredura do `Web3Listener` (a varredura periódica do checkpoint roda a cada `WEB3_SYNC_INTERVAL_MS` e registra cada resposta). `web3: stale` se passaram mais de 3 intervalos sem resposta (ou nenhuma desde a subida), `error` se o listener não está rodando. "Conectado" não foi usado como sinal justamente porque não prova entrega.

**Sem acoplar:** `lib/readiness.ts` ganhou um registro de checagens; o `server.ts`, que é quem sobe o listener, registra a checagem `web3`. O `app.ts` continua sem importar serviço de fundo — testes de rota seguem sem WSS real (ARCHITECTURE.md §3.3), e num app sem servidor completo o readiness checa só o banco, como antes. Checagem que lança vira `error`, nunca derruba a rota nem vaza a mensagem.

## 2026-10-03 — Centavo é a unidade canônica; valor com precisão sub-centavo é recusado, não arredondado

A entrada convertia com `Math.round(Number(amount) * 100)`, o que alterava em silêncio o valor cobrado: `"10.555"` virava 1056 centavos (**mais** do que o integrador pediu), `"1.004"` virava 100 (menos) e `"0.001"` virava 0 (cobrança de valor zero enviada ao provedor). Agora a conversão é feita sobre a string, com aritmética inteira, e mais de 2 casas decimais responde `400` — em gateway de pagamento, erro de centavo se recusa, não se arredonda.

Na saída, `amount` vinha do `Decimal` do Prisma, que descarta zero à direita: R$ 1,00 chegava ao integrador como `"1"`. A API e o webhook passam a devolver `amount` sempre com 2 casas e `amountCents` em centavos inteiros — a mesma unidade da conta.vc e do EMV. `amountCents` também é aceito na entrada (exclusivo com `amount`) e é o caminho recomendado para integradores, por não ter ambiguidade de arredondamento.

Mudança de contrato feita agora de propósito: não há integradores em produção ainda. Ver README, "O Valor da Cobrança: Centavos São a Unidade Canônica".

## 2026-09-29 — Balanço da sessão de 28–29/09: 8 PRs, 92 → 211 testes, nada verificado contra serviço real

Sessão de amadurecimento pedida pelo Rafael, que também perguntou se o endpoint interno da conta.vc tinha mudado. Esta entrada é um índice; o porquê de cada mudança está na entrada própria, acima.

| PR | O quê | Entrada |
|---|---|---|
| #1 | Validação do `emv` como BR Code; teste de contrato com conta.vc falsa; sonda `probe:contavc` (só GET). Correções: `getIntentStatus` com URL fixa, `webhookUrl` http aceita, API key comparada com `!==` | 28/09 |
| #2 | `Idempotency-Key` com outro valor → 422 | 29/09 |
| #3 | `/health/ready` com checagem do banco | 29/09 |
| #4 | `npm run webhook:resend` (ferramenta que faltava para a ARC-01) | 29/09 |
| #5 | Sem `as any` nos services | — (só `ARCHITECTURE.md` §3.4) |
| #6 | Node 22 LTS; `npm run typecheck` inclui `scripts/` | 29/09 |
| #7 | **Liquidação pelo horário do bloco do mint + checkpoint de blocos** | 29/09 |
| #8 | `npm run reconcile`; coluna `paidAt` e entregas órfãs → `FAILED`; `API_KEY` com várias chaves; tipo `Payment` gerado pelo Prisma; RPC no `/health/ready` | 29/09 (quatro entradas; tipo `Payment` só no `ARCHITECTURE.md` §3.4) |

Números: testes de 92 (11 arquivos) para 211 (20 arquivos); duas migrações (`add_sync_checkpoint`, `add_paid_at`); quatro scripts npm (`probe:contavc`, `webhook:resend`, `reconcile`, `typecheck`).

O achado mais sério foi o do #7: um Pix pago durante uma queda do serviço maior que ~20 minutos nunca liquidava. A varredura na subida só olhava 600 blocos, e o prazo da cobrança era comparado com "agora", não com o horário do mint. Ninguém tinha visto porque o serviço nunca tinha ficado fora esse tempo com cobrança em aberto.

Método aplicado em todos os PRs: cada regra nova foi verificada revertendo o código e vendo o teste correspondente falhar (skill `verificacao-antes-de-afirmar`, "teste que passa por acidente não é teste"). Isso pegou dois testes que passariam pelo motivo errado: os de SSRF com `http://` no #1, e um teste de guarda que casava com texto de comentário no #8.

**O que NÃO foi verificado**, e por quê: a sessão rodou em nuvem sem Docker e sem acesso a `app.conta.vc` nem a qualquer RPC da Base. Por isso a pergunta original (o endpoint mudou?) continua sem resposta, e nada rodou contra a conta.vc, a Base ou uma imagem Docker. Um comando de checagem que passei ao Rafael no começo estava errado (`tsx -e` não aceita `await` fora de função); o erro foi achado ao testá-lo e corrigido na conversa. Desde então, todo comando passado foi executado antes.

O Railway está com todos os serviços fora do ar desde 28/09. Antes de religá-lo, a verificação mais importante é checar um Pix real da conta.vc contra `inspectPixEmv`, porque se o formato real divergir toda cobrança nova é recusada.
