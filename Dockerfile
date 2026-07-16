# Self-contained multi-stage build — no host `npm run build` needed.
# Build:  docker build -t edubridge-api:latest .
# (Render/Fly build this directly from the repo.)

# ── Builder ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --legacy-peer-deps --network-timeout 600000
COPY . .
RUN npx prisma generate && npm run build

# ── Runner ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
# openssl is required by the Prisma engine at runtime
RUN apk add --no-cache dumb-init openssl
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY prisma ./prisma/

# Prod deps only, generate Prisma client, fix ownership of just the Prisma dirs
RUN npm ci --omit=dev --legacy-peer-deps --network-timeout 600000 \
  && npx prisma generate \
  && chown -R node:node /app/node_modules/.prisma \
  && chown -R node:node /app/node_modules/@prisma

# Compiled app from the builder stage
COPY --from=builder --chown=node:node /app/dist ./dist
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p uploads logs && chown node:node uploads logs

USER node

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--", "/entrypoint.sh"]
CMD ["node", "dist/main"]
