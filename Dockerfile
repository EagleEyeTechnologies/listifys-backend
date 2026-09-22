# =============================================================================
# listifys-api — production image
# Multi-stage build: compile TypeScript + native deps (argon2), then run lean.
#
# Build:
#   docker build -t listifys-api .
#
# Run API (default):
#   docker run --env-file .env -p 5001:5001 listifys-api
#
# Run BullMQ worker (same image):
#   docker run --env-file .env listifys-api node dist/worker.js
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: install dependencies (incl. native compile for argon2)
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm ci \
  && npm cache clean --force

# -----------------------------------------------------------------------------
# Stage 2: compile TypeScript → dist/
# -----------------------------------------------------------------------------
FROM deps AS build

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# -----------------------------------------------------------------------------
# Stage 3: runtime (non-root, no build toolchain)
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=5001

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --create-home api

COPY --from=build --chown=api:nodejs /app/package.json ./
COPY --from=build --chown=api:nodejs /app/package-lock.json ./
COPY --from=build --chown=api:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=api:nodejs /app/dist ./dist

USER api

EXPOSE 5001

# Liveness probe — process is up (see src/modules/health/health.routes.ts)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5001)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
