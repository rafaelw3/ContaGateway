#!/usr/bin/env bash
# Restaura um dump do Postgres (gerado por scripts/backup-postgres.sh) a
# partir de object storage S3-compatível — contraparte de restore do backup,
# usado tanto pra recuperação de desastre quanto num runbook de migração
# entre instâncias (ex: Railway → VPS).
#
# Roda igual em qualquer lugar (VPS/local/Railway) — mesma filosofia do
# backup-postgres.sh, nada específico de plataforma.
#
# Variáveis de ambiente obrigatórias:
#   DATABASE_URL              - string de conexão Postgres de DESTINO (onde restaurar)
#   BACKUP_S3_ENDPOINT        - endpoint S3-compatível (ex: https://<account_id>.r2.cloudflarestorage.com)
#   BACKUP_S3_BUCKET          - nome do bucket de origem
#   BACKUP_S3_ACCESS_KEY_ID   - access key do provedor de storage
#   BACKUP_S3_SECRET_ACCESS_KEY - secret key do provedor de storage
# Opcional:
#   BACKUP_PREFIX             - prefixo/pasta dentro do bucket (padrão: contagateway)
#   RESTORE_FILE              - nome exato do arquivo a restaurar (padrão: o mais recente no prefixo)
#   FORCE_RESTORE             - "1" para permitir restaurar sobre um banco que já tem dado
#                               (por padrão o script recusa, pra nunca sobrescrever produção
#                               por engano — ver DATA SEGURA abaixo)
#   OPS_ALERT_WEBHOOK_URL     - mesmo canal de alerta genérico do backup-postgres.sh/contractGuard
#
# DATA SEGURA: por padrão o script recusa restaurar se a tabela "Payment" no
# destino já tiver alguma linha — restaurar por cima de um banco com dado real
# pode duplicar/corromper estado financeiro. Só use FORCE_RESTORE=1 quando
# tiver certeza absoluta do que está fazendo (ex: banco de destino recém-criado
# que por algum motivo já rodou as migrations e ficou com alguma linha de teste).

set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL não configurada}"
: "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT não configurada}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET não configurada}"
: "${BACKUP_S3_ACCESS_KEY_ID:?BACKUP_S3_ACCESS_KEY_ID não configurada}"
: "${BACKUP_S3_SECRET_ACCESS_KEY:?BACKUP_S3_SECRET_ACCESS_KEY não configurada}"

PREFIX="${BACKUP_PREFIX:-contagateway}"

notify_failure() {
  local exit_code="$1"
  echo "[restore] ERRO: script falhou (exit ${exit_code})." >&2
  [ -z "${OPS_ALERT_WEBHOOK_URL:-}" ] && return 0
  local summary="⚠️ ContaGateway: restore do Postgres FALHOU (exit ${exit_code})."
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

export RCLONE_CONFIG_BACKUPDEST_TYPE="s3"
export RCLONE_CONFIG_BACKUPDEST_PROVIDER="Other"
export RCLONE_CONFIG_BACKUPDEST_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
export RCLONE_CONFIG_BACKUPDEST_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_BACKUPDEST_ENDPOINT="$BACKUP_S3_ENDPOINT"

# Mesmo tratamento do backup-postgres.sh: DATABASE_URL do Prisma vem com
# ?schema=public, que libpq (pg_restore) não entende.
PG_RESTORE_URL="${DATABASE_URL%%\?*}"

echo "[restore] Verificando se o destino já tem dado (proteção contra sobrescrita acidental)..."
EXISTING_ROWS=$(psql "$PG_RESTORE_URL" -tAc "SELECT count(*) FROM \"Payment\";" 2>/dev/null || echo "0")
if [ "${EXISTING_ROWS:-0}" != "0" ] && [ "${FORCE_RESTORE:-}" != "1" ]; then
  echo "[restore] RECUSADO: o destino já tem ${EXISTING_ROWS} linha(s) em \"Payment\"." >&2
  echo "[restore] Restaurar por cima pode duplicar/corromper estado financeiro real." >&2
  echo "[restore] Se isso for intencional e você tem certeza, rode de novo com FORCE_RESTORE=1." >&2
  exit 1
fi

if [ -n "${RESTORE_FILE:-}" ]; then
  FILENAME="$RESTORE_FILE"
  echo "[restore] Usando arquivo explícito: ${FILENAME}"
else
  echo "[restore] Nenhum RESTORE_FILE definido — buscando o backup mais recente em ${BACKUP_S3_BUCKET}/${PREFIX}/..."
  FILENAME=$(rclone lsf "backupdest:${BACKUP_S3_BUCKET}/${PREFIX}/" | sort | tail -n1)
  if [ -z "$FILENAME" ]; then
    echo "[restore] ERRO: nenhum backup encontrado em ${BACKUP_S3_BUCKET}/${PREFIX}/." >&2
    exit 1
  fi
  echo "[restore] Backup mais recente encontrado: ${FILENAME}"
fi

TMPFILE="/tmp/${FILENAME}"
echo "[restore] Baixando backupdest:${BACKUP_S3_BUCKET}/${PREFIX}/${FILENAME} para ${TMPFILE}..."
rclone copyto --s3-no-check-bucket "backupdest:${BACKUP_S3_BUCKET}/${PREFIX}/${FILENAME}" "$TMPFILE"

echo "[restore] Restaurando em ${DATABASE_URL%%@*}@... (host/db ocultos do log)..."
gunzip -c "$TMPFILE" | pg_restore --no-owner --clean --if-exists --dbname="$PG_RESTORE_URL"

rm -f "$TMPFILE"
echo "[restore] Concluído com sucesso."
