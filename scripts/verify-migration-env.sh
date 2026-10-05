#!/usr/bin/env bash
# Checagem pré-corte pra migração de instância (ex: Railway → VPS):
# compara as variáveis de ambiente que definem a
# IDENTIDADE do cliente/deploy entre origem e destino, e bloqueia a migração
# se qualquer uma divergir.
#
# Por quê: um mint de cBRL já foi parar em wallet errada por engano humano
# (ver ARCHITECTURE.md seção 1 / DECISIONS.md) — trocar a wallet/handle da conta.vc
# sem perceber ao provisionar uma instância nova é exatamente esse tipo de
# erro, só que na migração em vez de na configuração inicial. Este script
# existe pra pegar isso antes do corte, não depois.
#
# Uso:
#   ./scripts/verify-migration-env.sh <.env de origem> <.env de destino>
#
# Sai com 0 se todas as variáveis críticas forem idênticas nos dois arquivos.
# Sai com 1 (e imprime o que diverge) caso contrário — não prossiga com a
# migração se isso acontecer sem entender exatamente por quê.

set -Eeuo pipefail

SOURCE_ENV="${1:-}"
DEST_ENV="${2:-}"

if [ -z "$SOURCE_ENV" ] || [ -z "$DEST_ENV" ]; then
  echo "Uso: $0 <.env de origem> <.env de destino>" >&2
  exit 1
fi

for f in "$SOURCE_ENV" "$DEST_ENV"; do
  if [ ! -f "$f" ]; then
    echo "[verify-migration-env] ERRO: arquivo não encontrado: ${f}" >&2
    exit 1
  fi
done

# Variáveis que definem a IDENTIDADE do deploy — têm que ser idênticas entre
# origem e destino numa migração. Não inclui coisas que devem legitimamente
# mudar entre instâncias (DATABASE_URL, PORT, SENTRY_DSN, etc.).
CRITICAL_VARS=(
  "RECIPIENT_WALLET_ADDRESS"
  "CONTA_VC_USERNAME"
  "API_KEY"
  "WEBHOOK_SECRET"
)

get_var() {
  local file="$1"
  local key="$2"
  grep -E "^${key}=" "$file" 2>/dev/null | tail -n1 | cut -d'=' -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}

mismatch_found=0

for key in "${CRITICAL_VARS[@]}"; do
  source_val=$(get_var "$SOURCE_ENV" "$key")
  dest_val=$(get_var "$DEST_ENV" "$key")

  if [ -z "$source_val" ]; then
    echo "[verify-migration-env] AVISO: ${key} não está definida na origem (${SOURCE_ENV})." >&2
  fi
  if [ -z "$dest_val" ]; then
    echo "[verify-migration-env] BLOQUEADO: ${key} não está definida no destino (${DEST_ENV})." >&2
    mismatch_found=1
    continue
  fi

  if [ "$source_val" != "$dest_val" ]; then
    echo "[verify-migration-env] BLOQUEADO: ${key} diverge entre origem e destino." >&2
    echo "  origem : ${source_val}" >&2
    echo "  destino: ${dest_val}" >&2
    mismatch_found=1
  fi
done

if [ "$mismatch_found" != "0" ]; then
  echo "[verify-migration-env] Migração NÃO deve prosseguir até isso ser resolvido." >&2
  exit 1
fi

echo "[verify-migration-env] OK — todas as variáveis críticas conferem entre origem e destino."
exit 0
