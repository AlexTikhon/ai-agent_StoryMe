# ── Stage 1: Install dependencies ─────────────────────────────────────────────
FROM node:20-alpine AS deps

RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

WORKDIR /app

# Copy manifests for all workspace packages consumed by the API
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/types/package.json ./packages/types/
COPY apps/api/package.json ./apps/api/

# Install production + dev deps (needed for tsc build)
RUN pnpm install --frozen-lockfile

# ── Stage 2: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

# Prisma's `prisma generate` probes the local libssl to pick its query-engine
# binary. Without openssl installed it can't detect anything and silently
# guesses the wrong (1.1.x) target for this Alpine's actual OpenSSL 3.x, so
# the generated engine fails to load at runtime. Installing openssl here lets
# it detect correctly; schema.prisma also pins linux-musl-openssl-3.0.x
# explicitly so this doesn't depend on detection succeeding.
RUN apk add --no-cache openssl

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/types/node_modules ./packages/types/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules

# Copy source files
COPY tsconfig.base.json ./
COPY packages/types ./packages/types
COPY apps/api ./apps/api

# Build the shared types package first — apps/api's tsc build resolves
# @book/types via the workspace symlink to packages/types/dist, which
# doesn't exist until this runs.
RUN pnpm --filter @book/types build

# Generate Prisma client, then build the NestJS app
WORKDIR /app/apps/api
RUN pnpm prisma:generate && pnpm build

# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Security: run as non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001

# The Prisma query engine binary is dynamically linked against libssl —
# needed at runtime, not just at generate time (see builder stage comment).
RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production

# pnpm's node_modules is symlink-based: every dependency under
# apps/api/node_modules (and packages/types/node_modules) is a *relative*
# symlink into the shared node_modules/.pnpm virtual store, and @book/types
# is a relative symlink to ../../../packages/types. Those relative targets
# only resolve at this exact directory depth, so this stage preserves the
# same /app/{node_modules,packages/types,apps/api} layout the builder stage
# used instead of flattening apps/api/node_modules up to ./node_modules —
# flattening breaks every dependency's symlink resolution (including
# @nestjs/core and @prisma/client, not just workspace packages).
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/packages/types/dist ./packages/types/dist
COPY --from=builder --chown=nestjs:nodejs /app/packages/types/package.json ./packages/types/package.json
COPY --from=builder --chown=nestjs:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=nestjs:nodejs /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder --chown=nestjs:nodejs /app/apps/api/prisma ./apps/api/prisma
# Embedded Unicode fonts (Noto Sans) used by the PDF renderer for Cyrillic/
# non-Latin text — resolved at runtime relative to dist/, not an OS font path.
COPY --from=builder --chown=nestjs:nodejs /app/apps/api/assets ./apps/api/assets

WORKDIR /app/apps/api

USER nestjs

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# NOTE: this does not run `prisma migrate deploy` — migrations must be run as
# a separate step before starting the container (see docs/deployment-readiness.md).
CMD ["node", "dist/main"]
