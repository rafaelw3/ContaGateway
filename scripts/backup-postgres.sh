#!/usr/bin/env bash
# Backup do Postgres para object storage S3-compatível (R2, S3, B2, etc.).
#
# Roda igual em qualquer lugar (VPS/local via cron do sistema, Railway via
# serviço com cronSchedule) — nunca depende de expor o Postgres publicamente,
# porque roda onde o banco já está alcançável (rede privada do projeto, ou a
# mesma máquina). Ver README "Backup do Banco de Dados".
#
# Variáveis de ambiente obrigatórias:
#   DATABASE_URL              - string de conexão Postgres a fazer backup
#   BACKUP_S3_ENDPOINT        - endpoint S3-compatível (ex: https://<account_id>.r2.cloudflarestorage.com)
#   BACKUP_S3_BUCKET          - nome do bucket de destino
#   BACKUP_S3_ACCESS_KEY_ID   - access key do provedor de storage
#   BACKUP_S3_SECRET_ACCESS_KEY - secret key do provedor de storage
# Opcional:
#   BACKUP_RETENTION_DAYS     - dias de retenção (padrão: 30)
#   BACKUP_PREFIX             - prefixo/pasta dentro do bucket (padrão: contagateway)
#   SENTRY_DSN                - se setado, reporta check-ins ao Sentry Crons (o
#                               mesmo DSN da API). Detecta backup que FALHOU e
#                               backup que NÃO RODOU — para um backup, "não
#                               rodou" é tão grave quanto "quebrou". Vazio
#                               desativa, sem quebrar nada.
#   SENTRY_MONITOR_SLUG       - slug do monitor (padrão: contagateway-postgres-backup).
#                               Mantenha estável: é a chave do check-in, e trocar
#                               a cada deploy deixa monitores órfãos.
#   SENTRY_MONITOR_SCHEDULE   - crontab de 5 campos que o monitor espera
#                               (padrão: "0 3 * * *"). Precisa bater com o
#                               cronSchedule do serviço, senão o Sentry acusa
#                               ausência na hora errada.
#   OPS_ALERT_WEBHOOK_URL     - mesmo canal de alerta genérico do contractGuard
#                               (Slack/Discord/Telegram/n8n, uma ou mais URLs
#                               separadas por vírgula — ver .env.example).
#                               Se setado, dispara um alerta caso o backup falhe.

set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL não configurada}"
: "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT não configurada}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET não configurada}"
: "${BACKUP_S3_ACCESS_KEY_ID:?BACKUP_S3_ACCESS_KEY_ID não configurada}"
: "${BACKUP_S3_SECRET_ACCESS_KEY:?BACKUP_S3_SECRET_ACCESS_KEY não configurada}"

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
PREFIX="${BACKUP_PREFIX:-contagateway}"

# ---------------------------------------------------------------------------
# Sentry Crons (opcional): check-in no início e no fim de cada execução.
#
# Por que check-in e não apenas o webhook de falha: o webhook só dispara quando
# o script roda e quebra. Se o agendador não disparar o job, ninguém é avisado —
# e um backup que silenciosamente parou de rodar é pior do que um que falha
# ruidosamente. O Sentry cobra a ausência contra o schedule do monitor.
#
# Tudo aqui é best-effort, com timeout curto e erro engolido: Sentry fora do ar
# nunca pode derrubar o backup nem alterar o código de saída do script.
# ---------------------------------------------------------------------------
MONITOR_SLUG="${SENTRY_MONITOR_SLUG:-contagateway-postgres-backup}"
MONITOR_SCHEDULE="${SENTRY_MONITOR_SCHEDULE:-0 3 * * *}"
CHECKIN_ID=""
CHECKIN_BASE=""

if [ -n "${SENTRY_DSN:-}" ]; then
  # DSN tem o formato https://<public_key>@<host>/<project_id>
  dsn_body="${SENTRY_DSN#*://}"
  dsn_key="${dsn_body%%@*}"
  dsn_rest="${dsn_body#*@}"
  dsn_host="${dsn_rest%%/*}"
  dsn_project="${dsn_rest##*/}"

  if [ -n "$dsn_key" ] && [ -n "$dsn_host" ] && [ -n "$dsn_project" ] && [ "$dsn_host" != "$dsn_rest" ]; then
    CHECKIN_BASE="https://${dsn_host}/api/${dsn_project}/cron/${MONITOR_SLUG}/${dsn_key}/"
  else
    echo "[backup] AVISO: SENTRY_DSN em formato inesperado; check-ins desativados." >&2
  fi
fi

# O id do check-in é gerado AQUI, de propósito: este endpoint responde
# "202 Accepted" com corpo vazio (ingestão assíncrona), então não há id para ler
# da resposta. E fechar o check-in é um POST com o mesmo `check_in_id` — o
# `PUT .../<id>/` que a documentação de outras versões sugere responde 404 aqui.
# Ambos verificados contra a API em 2026-10-03.
#
# O primeiro check-in também cria/atualiza o monitor (upsert) com o schedule,
# para o Sentry saber quando esperar a próxima execução e acusar ausência.
# checkin_margin: quanto de atraso ainda não conta como perdido.
# max_runtime: a partir de quanto tempo a execução conta como travada.
checkin_start() {
  [ -z "$CHECKIN_BASE" ] && return 0

  CHECKIN_ID=$(openssl rand -hex 16 2>/dev/null) || CHECKIN_ID=""
  if [ -z "$CHECKIN_ID" ]; then
    echo "[backup] AVISO: não foi possível gerar id de check-in; Sentry Crons desativado nesta execução." >&2
    return 0
  fi

  local payload
  payload=$(printf '{"check_in_id":"%s","status":"in_progress","monitor_config":{"schedule":{"type":"crontab","value":"%s"},"timezone":"UTC","checkin_margin":15,"max_runtime":30}}' "$CHECKIN_ID" "$MONITOR_SCHEDULE")

  if curl -sf -X POST "$CHECKIN_BASE" -H "Content-Type: application/json" --max-time 10 -d "$payload" >/dev/null 2>&1; then
    echo "[backup] Check-in aberto no Sentry (monitor ${MONITOR_SLUG})."
  else
    echo "[backup] AVISO: check-in inicial no Sentry não foi aceito; o backup segue normalmente." >&2
  fi
  return 0
}

checkin_finish() {
  local status="$1"
  [ -z "$CHECKIN_BASE" ] && return 0
  [ -z "$CHECKIN_ID" ] && return 0

  curl -s -X POST "$CHECKIN_BASE" \
    -H "Content-Type: application/json" \
    --max-time 10 \
    -d "{\"check_in_id\":\"${CHECKIN_ID}\",\"status\":\"${status}\"}" >/dev/null 2>&1 || true
  return 0
}

# Alerta de falha — mesmo padrão de canal genérico do contractGuard.ts, só que
# em bash: se OPS_ALERT_WEBHOOK_URL estiver setada, dispara em cada URL (uma
# ou mais, separadas por vírgula). Nunca deixa uma falha no próprio alerta
# derrubar o script com outro código de saída.
notify_failure() {
  local exit_code="$1"
  echo "[backup] ERRO: script falhou (exit ${exit_code})." >&2

  # Fecha o check-in como erro antes do webhook: é o canal que também detecta
  # execução ausente, então é o que não deve depender de mais nada dar certo.
  checkin_finish "error"

  [ -z "${OPS_ALERT_WEBHOOK_URL:-}" ] && return 0
  local summary="⚠️ ContaGateway: backup do Postgres FALHOU (exit ${exit_code}). Ver logs do serviço contagateway-backup no Railway."
  IFS=',' read -ra urls <<< "$OPS_ALERT_WEBHOOK_URL"
  for url in "${urls[@]}"; do
    url="$(echo "$url" | xargs)"
    [ -z "$url" ] && continue
    curl -s -X POST "$url" -H "Content-Type: application/json" \
      -d "{\"text\":\"${summary}\",\"content\":\"${summary}\"}" \
      --max-time 5 >/dev/null 2>&1 || true
  done
}
trap 'notify_failure "$?"' ERR

checkin_start

# rclone lê a config do remote inteiramente via env vars (RCLONE_CONFIG_<REMOTE>_<CHAVE>)
# - nenhum arquivo de config em disco, alinhado com a filosofia 12-factor do projeto.
export RCLONE_CONFIG_BACKUPDEST_TYPE="s3"
export RCLONE_CONFIG_BACKUPDEST_PROVIDER="Other"
export RCLONE_CONFIG_BACKUPDEST_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
export RCLONE_CONFIG_BACKUPDEST_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_BACKUPDEST_ENDPOINT="$BACKUP_S3_ENDPOINT"

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILENAME="contagateway-${TIMESTAMP}.dump.gz"
TMPFILE="/tmp/${FILENAME}"

# DATABASE_URL vem no formato do Prisma, com ?schema=public no final — libpq
# (usado pelo pg_dump) não entende esse parâmetro, então removemos antes de usar.
PG_DUMP_URL="${DATABASE_URL%%\?*}"

echo "[backup] Gerando dump em ${TMPFILE}..."
pg_dump "$PG_DUMP_URL" --format=custom | gzip > "$TMPFILE"

SIZE=$(du -h "$TMPFILE" | cut -f1)
echo "[backup] Dump gerado (${SIZE}). Enviando para backupdest:${BACKUP_S3_BUCKET}/${PREFIX}/${FILENAME}..."

# --s3-no-check-bucket evita que o rclone tente um CreateBucket de preflight —
# um token de API do R2 escopado só a leitura/escrita de objetos (boa prática
# de menor privilégio) não tem permissão de gerenciar buckets e recebe 403 aí,
# mesmo o bucket já existindo e a credencial tendo acesso de sobra pra escrever nele.
rclone copyto --s3-no-check-bucket "$TMPFILE" "backupdest:${BACKUP_S3_BUCKET}/${PREFIX}/${FILENAME}"

rm -f "$TMPFILE"
echo "[backup] Upload concluído."

echo "[backup] Removendo backups com mais de ${RETENTION_DAYS} dias..."
rclone delete "backupdest:${BACKUP_S3_BUCKET}/${PREFIX}" --min-age "${RETENTION_DAYS}d"

# Só aqui o check-in fecha como OK: fechar antes diria "deu certo" com o upload
# ou a retenção ainda por fazer.
checkin_finish "ok"

echo "[backup] Concluído com sucesso."
