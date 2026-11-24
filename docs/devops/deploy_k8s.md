# OTK zk-Metering — K8s Deployment Guide

Deployment guide for the OTK metering API server on Kubernetes (G2 / RB-082).

## Deploy contract

| Parameter | Value | Source |
|-----------|-------|--------|
| Container port | `8787` | `API_PORT` env / server.ts default |
| Health path (liveness) | `GET /healthz` | routes.ts (H4.4) |
| Health path (readiness) | `GET /readyz` | routes.ts (H4.4) |
| Image | `otk-zk-metering:latest` | Configurable via `values.yaml` |
| Runtime | `node --import tsx/esm src/api/server.ts` | Dockerfile CMD |
| Min memory | 128Mi | values.yaml requests |
| Min CPU | 100m | values.yaml requests |

## Quick deploy (Helm)

```bash
# From repo root (requires helm >= 3.x)
helm install otk ./infra/helm/otk

# With custom image tag
helm install otk ./infra/helm/otk --set image.tag=v0.1.0

# Dry-run
helm install otk ./infra/helm/otk --dry-run --debug

# Render manifests to file
helm template otk ./infra/helm/otk > /tmp/otk-manifests.yaml
kubectl apply --dry-run=client -f /tmp/otk-manifests.yaml
```

## Validate chart structure (no Helm required)

```bash
bash scripts/ops/render_helm.sh
```

## Build + run (Docker)

```bash
# Build
docker build -f docker/api/Dockerfile -t otk-zk-metering:latest .

# Run (local dev)
docker run -p 8787:8787 otk-zk-metering:latest

# Or via docker-compose
docker compose -f docker/api/docker-compose.api.yml up --build
```

## Health check

```bash
curl http://localhost:8787/healthz
# {"ok":true,"uptime":"3.1","ts":"2026-03-06T...Z"}

curl http://localhost:8787/readyz
# {"ok":true,"redis":"up","ts":"2026-03-06T...Z"}
```

## Liveness / Readiness probes

Liveness hits `GET /healthz` (process alive). Readiness hits `GET /readyz` (Redis-backed traffic check, H4.4).

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 8787
  initialDelaySeconds: 10
  periodSeconds: 15
  timeoutSeconds: 5

readinessProbe:
  httpGet:
    path: /readyz
    port: 8787
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 3
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `8787` | HTTP port |
| `NODE_ENV` | `production` | Node environment |
| `GIT_HEAD` | *(unset)* | Optional git SHA injected at deploy time |

## Out-of-scope

- Ingress / TLS termination (cloud-provider specific)
- cert-manager integration
- Horizontal Pod Autoscaler
- External secrets manager (Vault, AWS SSM)
- Multi-environment GitOps pipeline
- Service mesh (Istio, Linkerd)

## Rollback

```bash
helm rollback otk
# or
kubectl rollout undo deployment/otk
```
