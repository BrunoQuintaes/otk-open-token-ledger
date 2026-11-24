# OTK zk-Metering — ProverDaemon
#
# Builds the ZK proof generation microservice image.
# Runtime: Node.js 24-slim + tsx + snarkjs (CPU-bound ZK proving).
#
# ZK artifacts (wasm + zkeys) are bundled into the image.
# For production, consider mounting keys as a read-only volume instead
# (avoids rebuildng the image on key rotation):
#   -v /secure/keys:/app/zk/keys:ro
#
# Exposed port: 3001 (override with PROVER_PORT env var)
# Health path: GET /health
#
# Build:
#   docker build -f docker/prover/Dockerfile -t otk-prover:latest .
#
# Run (Phase 1 — no Redis):
#   docker run -p 3001:3001 otk-prover:latest
#
# Run (Phase 2 — BullMQ/Redis):
#   docker run -p 3001:3001 -e OTK_REDIS_URL=redis://redis:6379 otk-prover:latest

# ─── Deps stage ──────────────────────────────────────────────────────────────
FROM node:24-slim AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime

WORKDIR /app

# Node modules
COPY --from=deps /app/node_modules ./node_modules

# Source
COPY package*.json ./
COPY tsconfig.json ./
COPY src/ ./src/

# ZK circuit artifacts — wasm (witness generation) + zkeys (proving)
# Only the build outputs needed at runtime (not the full zk/build dir)
COPY zk/build/metering_v1_js/ ./zk/build/metering_v1_js/
COPY zk/build/metering_v2_js/ ./zk/build/metering_v2_js/
# v2 MPC key (5 contributors + Hermez Phase 1) — production proving key
COPY zk/keys/metering_v2_final_mpc.zkey ./zk/keys/
COPY zk/keys/metering_v2_vkey_mpc.json ./zk/keys/
# NOTE: v1 key (metering_v1_final.zkey) is NOT committed to the repo.
# To enable v1 proving, mount the key at runtime and set PROVER_ZKEY_V1:
#   docker run -v /path/to/metering_v1_final.zkey:/app/zk/keys/metering_v1_final.zkey \
#              -e PROVER_ZKEY_V1=zk/keys/metering_v1_final.zkey ...

# Non-root user
RUN groupadd -r otk && useradd -r -g otk otk && chown -R otk:otk /app
USER otk

EXPOSE 3001

ENV NODE_ENV=production \
    PROVER_PORT=3001

# ZK artifact paths — v2 only (v1 key not bundled; see COPY comment above)
ENV PROVER_WASM_V1=zk/build/metering_v1_js/metering_v1.wasm \
    PROVER_WASM_V2=zk/build/metering_v2_js/metering_v2.wasm \
    PROVER_ZKEY_V2=zk/keys/metering_v2_final_mpc.zkey

# Health check
HEALTHCHECK --interval=20s --timeout=10s --start-period=30s --retries=3 \
  CMD node --input-type=module --eval \
    "const r=await fetch('http://localhost:'+process.env.PROVER_PORT+'/health');process.exit(r.ok?0:1);" \
    2>/dev/null || exit 1

CMD ["node", "--import", "tsx/esm", "src/prover/ProverDaemon.ts"]
