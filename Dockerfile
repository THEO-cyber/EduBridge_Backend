# Pre-build locally with: npm run build
# Then run: docker build -t edubridge-api:latest . && docker compose up -d

FROM node:20-alpine AS runner

# openssl is required by Prisma migration engine at runtime
RUN apk add --no-cache dumb-init openssl

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
COPY prisma ./prisma/

# Install prod deps, generate Prisma client, then fix ownership of Prisma dirs
# (only ~2 dirs, not all of node_modules — avoids the large-chown timeout)
RUN npm ci --omit=dev --legacy-peer-deps --network-timeout 600000 \
  && npx prisma generate \
  && chown -R node:node /app/node_modules/.prisma \
  && chown -R node:node /app/node_modules/@prisma

# Copy pre-built app (dist/ must exist on host — run `npm run build` first)
COPY --chown=node:node dist ./dist
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p uploads logs && chown node:node uploads logs

USER node

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--", "/entrypoint.sh"]
CMD ["node", "dist/main"]
