# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Install build tools needed for native modules (bcrypt, etc.)
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci --legacy-peer-deps

COPY . .

RUN npm run build
RUN npx prisma generate

# ── Stage 2: Production image ─────────────────────────────────────────────────
FROM node:20-alpine AS runner

# ffmpeg-static bundles a Linux binary — it only works on Linux (perfect for Docker)
# For the base image we keep it minimal; ffmpeg-static is included via npm
RUN apk add --no-cache dumb-init

WORKDIR /app

ENV NODE_ENV=production

# Copy only production dependencies
COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci --omit=dev --legacy-peer-deps && npx prisma generate

# Copy built application
COPY --from=builder /app/dist ./dist

# Create uploads directory (for local dev fallback)
RUN mkdir -p uploads && chown -R node:node /app

USER node

EXPOSE 3000

# dumb-init handles PID 1 + signal forwarding (clean shutdown)
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main"]
