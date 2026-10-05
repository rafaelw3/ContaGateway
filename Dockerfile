# ==========================================
# Estágio 1: Build da Aplicação (builder)
# ==========================================
FROM node:26-alpine AS builder

RUN apk add --no-cache openssl

WORKDIR /app

# Instala todas as dependências (respeitando .npmrc: ignore-scripts=true)
COPY package*.json .npmrc ./
RUN npm ci

# Copia schema Prisma e gera o Prisma Client
COPY prisma/ ./prisma/
RUN npx prisma generate

# Copia código-fonte e compila TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Remove dependências de desenvolvimento para manter apenas produção
RUN npm prune --omit=dev

# ==========================================
# Estágio 2: Imagem Final de Produção (runner)
# ==========================================
FROM node:26-alpine AS runner

# Instala dependências de runtime necessárias (OpenSSL para Prisma, dumb-init
# para PID 1, wget para healthcheck; postgresql-client + rclone + curl só são
# usados pelo serviço de backup agendado — ver scripts/backup-postgres.sh,
# curl é o alerta de falha via OPS_ALERT_WEBHOOK_URL — mas ficam na mesma
# imagem pra não precisar manter um Dockerfile separado)
RUN apk add --no-cache openssl dumb-init wget postgresql-client rclone curl bash

ENV NODE_ENV=production
WORKDIR /app

RUN chown -R node:node /app

# Copia dependências de produção e artefatos compilados do builder
COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/prisma ./prisma
COPY --chown=node:node docker-entrypoint.sh ./
COPY --chown=node:node scripts/backup-postgres.sh ./scripts/backup-postgres.sh
RUN chmod +x docker-entrypoint.sh scripts/backup-postgres.sh

# Executa com usuário não-root para máxima segurança
USER node

EXPOSE 3000

# Healthcheck nativo consultando o endpoint /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

ENTRYPOINT ["dumb-init", "--", "./docker-entrypoint.sh"]
CMD ["node", "--import", "./dist/instrument.js", "dist/server.js"]
