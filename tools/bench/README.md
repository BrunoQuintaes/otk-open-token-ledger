# Benchmark Rig — Scaffold

**ADR:** `docs/architecture/adr/ADR-0102-benchmark-rig-linux-docker-netem.md`
**Status:** Scaffold (implementação pendente — TODO U12.x)

---

## Objetivo

Fornecer benchmark reprodutível e defensável em ambiente Linux/Docker com:
- Limites de CPU/RAM explícitos
- Simulação de latência WAN via `tc-netem`
- N≥100 amostras com CI95, percentis e outliers
- EVD completo em `docs/_ops/bench_<TS>/`

---

## Cenários

| Cenário | netem delay | N | Objetivo |
|---------|-------------|---|----------|
| baseline | 0ms | 100 | throughput máximo (loopback) |
| wan_light | 50ms | 100 | WAN inter-região |
| wan_heavy | 150ms | 50 | WAN intercontinental + jitter |
| zk_inprocess | — | 100 | Groth16 in-process (warmup=5) |
| zk_coldstart | — | 20 | Groth16 cold-start (CLI) |

---

## TODO

```
tools/bench/
├── Dockerfile.bench          # TODO(U12.x): Ubuntu 22.04 + Node v24 + snarkjs
├── docker-compose.bench.yml  # TODO(U12.x): limites CPU/RAM + volumes
└── scripts/
    ├── run_bench.sh          # TODO(U12.x): script principal
    ├── setup_netem.sh        # TODO(U12.x): tc qdisc netem
    └── collect_evidence.sh   # TODO(U12.x): uname, cpuinfo, seed, outputs
```

---

## Uso Esperado (pós-implementação)

```bash
# Cenário baseline
docker compose -f tools/bench/docker-compose.bench.yml run bench --scenario=baseline --N=100

# Cenário WAN light
docker compose -f tools/bench/docker-compose.bench.yml run bench --scenario=wan_light --N=100

# EVD em docs/_ops/bench_<TS>/
ls docs/_ops/bench_*/
```

---

## Evidência Existente (U9.6)

Docker bench parcial já executado em:
`docs/_ops/u9/U9_6_DOCKER_BENCH_20260221/`

Este rig é a formalização e extensão daquele experimento.
