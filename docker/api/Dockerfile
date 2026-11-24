# OTK zk-Metering — API Server
#
# Builds the REST API image for use in K8s / Docker Compose / ECS.
# Runtime: Node.js 24-slim + tsx (no TypeScript pre-compilation step).
#
# Exposed port: 8787 (override with API_PORT env var)
# Health path: GET /health
#
# Build:
#   docker build -f docker/api/Dockerfile -t otk-api:latest .
#
# Run (minimal):
#   docker run -p 8787:8787 -e OTK_ADMIN_KEY=<generated> -e OTK_TENANTS=<tenant>/OWNER:<generated> -e OTK_CSRF_SECRET=<generated> otk-api:latest
#
# PA-07: supports OTK_DB_URL (PostgreSQL write-behind) + PROVER_URL (ProverDaemon)

# ─── Deps stage ──────────────────────────────────────────────────────────────
FROM node:24-slim AS deps

WORKDIR /app

# Copy package manifests first for layer caching
COPY package*.json ./

# Install all deps (tsx required at runtime — no separate build step)
RUN npm ci --include=dev

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime

WORKDIR /app

# Copy installed modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source
COPY package*.json ./
COPY tsconfig.json ./
COPY src/ ./src/
# P1.2: OpenAPI spec must be available at runtime for GET /openapi.json
COPY docs/api/ ./docs/api/

# Non-root user for security
RUN groupadd -r otk && useradd -r -g otk otk && chown -R otk:otk /app
USER otk

# Default port
EXPOSE 8787

# Defaults — override at runtime via env
ENV NODE_ENV=production \
    API_PORT=8787

# Health check — Node 24 has built-in fetch (no curl required)
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD node --input-type=module --eval \
    "const r=await fetch('http://localhost:'+process.env.API_PORT+'/health');process.exit(r.ok?0:1);" \
    2>/dev/null || exit 1

CMD ["node", "--import", "tsx/esm", "src/api/server.ts"]
