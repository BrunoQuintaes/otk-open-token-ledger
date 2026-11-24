# scripts/ops — Operational Scripts

Scripts de operação para rede Besu IBFT, Gate R0, e utilidades do projeto OTK.

---

## Besu IBFT — Rede local (4 nós)

| Script | Função |
|--------|--------|
| `besu_up.sh` | Sobe a rede IBFT (docker compose detached) |
| `besu_up_full.sh` | Sobe + aguarda health + exibe enodes |
| `besu_down.sh` | Para e remove containers |
| `besu_rpc_smoke.sh [rpc_url]` | Smoke test RPC (eth_blockNumber, net_version, ibft_getValidators) |
| `besu_harness_check.sh` | Verifica pré-condições antes de testes E2E |
| `besu_health.sh` | Health check rápido dos 4 nós |
| `besu_logs.sh` | Exibe logs dos containers |
| `besu_get_enode.sh` | Extrai enodes da rede para bootnodes.json |
| `besu_network_init.sh` | Inicializa genesis + configura rede do zero |

**Fluxo típico:**
```bash
bash scripts/ops/besu_up_full.sh      # sobe rede
bash scripts/ops/besu_rpc_smoke.sh    # valida RPC
# ... deploy contratos / testes E2E ...
bash scripts/ops/besu_down.sh         # derruba rede
```

**RPC padrão:** `http://127.0.0.1:8545`
**Config:** `infra/ibft/` + `infra/besu/`
**ADR:** [ADR-EVM-0002](../../docs/architecture/adr/ADR-EVM-0002-berlin-compat-no-push0.md) — evmVersion Berlin (NO PUSH0)

---

## Gate R0 — Revalidação obrigatória

| Script | Função |
|--------|--------|
| `gate_r0_revalidate.sh` | Executa Gate R0 completo (secret scan + build + PUSH0 detector) |
| `hooks/pre-commit.sh` | Hook git: roda antes de cada commit |
| `install-hooks.sh` | Instala o pre-commit hook no `.git/hooks/` |

**Uso:**
```bash
bash scripts/ops/gate_r0_revalidate.sh
```
Relatório salvo em: `docs/_ops/revalidation/REVALIDATION_<TS>/`

---

## IBFT Governance Helpers

| Script | Função |
|--------|--------|
| `ibft_list_validators.sh` | Lista validators ativos via RPC |
| `ibft_add_validator.sh <address>` | Propõe adição de validator (requer quorum) |
| `ibft_remove_validator.sh <address>` | Propõe remoção de validator (requer quorum) |

Requer rede Besu ativa. Falham com mensagem clara se RPC indisponível.

---

## Utilitários

| Script | Função |
|--------|--------|
| `detect_push0.js` | Detecta opcode PUSH0 em bytecode compilado |
| `check_berlin_compliance.mjs` | Verifica compatibilidade Berlin nos contratos |
| `build_econ_report.mjs` | Gera relatório econômico (CU model) |
| `run_scenario_analysis.mjs` | Análise de cenários de uso |

---

## Referências

- Governança IBFT: [docs/governance/README.md](../../docs/governance/README.md)
- Gate R0 docs: [docs/_ops/revalidation/README.md](../../docs/_ops/revalidation/README.md)
- Aliases de paths: [docs/_meta/PATH_ALIASES.md](../../docs/_meta/PATH_ALIASES.md)
