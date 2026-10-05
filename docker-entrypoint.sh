#!/bin/sh
set -e

# Aplica as migrations pendentes no PostgreSQL (idempotente e seguro para produção,
# ao contrário de `db push`, que não mantém histórico de mudanças no schema).
#
# SKIP_MIGRATIONS=1 pula esta etapa. Serve para quem usa esta mesma imagem sem
# ser o servidor da API — o serviço de backup (scripts/backup-postgres.sh), por
# exemplo: ele só precisa ler o banco, e migrar o schema a cada execução
# agendada daria a um job de leitura o poder de alterar a estrutura do banco.
if [ "${SKIP_MIGRATIONS:-}" = "1" ]; then
  echo "📦 [ContaGateway] SKIP_MIGRATIONS=1: pulando migrations."
else
  echo "📦 [ContaGateway] Aplicando migrations no banco de dados..."
  npx prisma migrate deploy
fi

echo "🚀 [ContaGateway] Iniciando serviço..."
exec "$@"
