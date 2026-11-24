#!/usr/bin/env python3
"""R05 - figuras (PNG + PDF vetorial) a partir de data/pairs_633.csv e data/metrics_long.csv.
Uso: python -E -P figures.py --data <runs/R05/data> --out <runs/R05/figures>
Somente matplotlib (sem rede). Cores validadas (paleta categorica: azul / laranja / verde-agua)."""
import argparse, csv, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True); ap.add_argument("--out", required=True); a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
MODELS = ["gpt-4o-mini-2024-07-18", "claude-haiku-4-5-20251001", "gemini-3.5-flash-lite"]
COLOR = {"gpt-4o-mini-2024-07-18": "#2a78d6", "claude-haiku-4-5-20251001": "#eb6834", "gemini-3.5-flash-lite": "#1baf7a"}
FAMILIES = ["pt_prose", "en_prose", "code_ts", "json", "markdown_table", "mixed_unicode", "numeric", "tiny"]
SPLITS = ["train", "validation", "holdout"]
SL = {"train": "train", "validation": "valid.", "holdout": "holdout"}
with open(os.path.join(a.data, "pairs_633.csv"), newline="", encoding="utf-8") as f: pairs = list(csv.DictReader(f))
with open(os.path.join(a.data, "metrics_long.csv"), newline="", encoding="utf-8") as f: metrics = list(csv.DictReader(f))
plt.rcParams.update({"font.size": 9, "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "grid.color": "#e6e6e3", "grid.linewidth": 0.6, "axes.edgecolor": "#8a8a85", "axes.labelcolor": "#2b2b2a", "xtick.color": "#2b2b2a", "ytick.color": "#2b2b2a", "legend.frameon": False})

def save(fig, name):
    fig.savefig(os.path.join(a.out, name + ".png"), dpi=160, bbox_inches="tight")
    fig.savefig(os.path.join(a.out, name + ".pdf"), bbox_inches="tight")
    plt.close(fig)

# Figura 1 - erro assinado (estimador - declarado) por modelo e split: RAW x CALIBRADO (boxplots)
fig, axes = plt.subplots(1, 3, figsize=(12, 3.8), sharey=False)
for ax, m in zip(axes, MODELS):
    data, labels, cols = [], [], []
    for s in SPLITS:
        rows = [r for r in pairs if r["model"] == m and r["split"] == s]
        data.append([int(r["err_raw"]) for r in rows]); labels.append(f"{SL[s]}\nRAW"); cols.append("#c3c2b7")
        data.append([int(r["err_calibrated"]) for r in rows]); labels.append(f"{SL[s]}\nCAL"); cols.append(COLOR[m])
    bp = ax.boxplot(data, widths=0.6, patch_artist=True, showfliers=True, flierprops={"marker": ".", "markersize": 3, "markeredgecolor": "#8a8a85"}, medianprops={"color": "#1a1a19", "linewidth": 1.2})
    for patch, c in zip(bp["boxes"], cols): patch.set_facecolor(c); patch.set_alpha(0.75); patch.set_edgecolor("#5c5c58")
    ax.axhline(0, color="#5c5c58", linewidth=0.8, linestyle="--")
    ax.set_xticks(range(1, len(labels) + 1)); ax.set_xticklabels(labels, fontsize=7.5)
    ax.set_title(m, fontsize=9, color="#2b2b2a"); ax.set_ylabel("erro (tokens) = estimador - declarado" if m == MODELS[0] else "")
fig.suptitle("Erro do contador local por modelo e split: RAW (cru) x CALIBRADO (afim congelado)", fontsize=10, color="#2b2b2a")
save(fig, "fig1_error_by_model_split")

# Figura 2 - MAE por familia e modelo (estimador CALIBRADO, todos os pares), barras agrupadas
fig, ax = plt.subplots(figsize=(10.5, 3.8))
w = 0.26
for i, m in enumerate(MODELS):
    vals = []
    for fam in FAMILIES:
        r = next(x for x in metrics if x["model"] == m and x["split"] == "all" and x["family"] == fam and x["estimator"].startswith("CAL"))
        vals.append(float(r["mae"]))
    xs = [k + (i - 1) * w for k in range(len(FAMILIES))]
    ax.bar(xs, vals, width=w - 0.03, color=COLOR[m], label=m, edgecolor="none")
    for x, v in zip(xs, vals): ax.text(x, v + 1.0, f"{v:.0f}", ha="center", va="bottom", fontsize=6.5, color="#2b2b2a")
ax.set_xticks(range(len(FAMILIES))); ax.set_xticklabels(FAMILIES, fontsize=8)
ax.set_ylabel("MAE (tokens), estimador calibrado"); ax.legend(fontsize=8, loc="upper left")
ax.set_title("Erro absoluto medio por familia de conteudo (todos os pares; parametros congelados)", fontsize=10, color="#2b2b2a")
save(fig, "fig2_mae_by_family")

# Figura 3 - local x declarado por modelo, com y = x e a reta afim congelada
PARAMS = {"gpt-4o-mini-2024-07-18": (1.000000, 7.000000), "claude-haiku-4-5-20251001": (1.165964, 4.101752), "gemini-3.5-flash-lite": (1.252777, -6.097995)}
fig, axes = plt.subplots(1, 3, figsize=(10.5, 3.6))
MK = {"train": "o", "validation": "s", "holdout": "^"}
for ax, m in zip(axes, MODELS):
    rows = [r for r in pairs if r["model"] == m]
    for s in SPLITS:
        rs = [r for r in rows if r["split"] == s]
        ax.scatter([int(r["local_raw"]) for r in rs], [int(r["declared"]) for r in rs], s=14, marker=MK[s], color=COLOR[m], alpha=0.7, edgecolors="white", linewidths=0.4, label=s)
    mx = max(int(r["local_raw"]) for r in rows); lo, hi = 0, mx * 1.05
    ax.plot([lo, hi], [lo, hi], color="#8a8a85", linewidth=0.9, linestyle="--", label="y = x")
    sl, ic = PARAMS[m]; ax.plot([lo, hi], [sl * lo + ic, sl * hi + ic], color="#1a1a19", linewidth=1.1, label=f"afim congelada {sl:.6f}x{ic:+.6f}")
    ax.set_title(m, fontsize=9, color="#2b2b2a"); ax.set_xlabel("tokens locais (contador OTK, cru)"); ax.set_ylabel("tokens declarados pelo provedor" if m == MODELS[0] else "")
    ax.legend(fontsize=6.5, loc="upper left")
fig.suptitle("Contagem local x declarada por modelo (633 pares) e a reta afim congelada do perfil", fontsize=10, color="#2b2b2a")
save(fig, "fig3_local_vs_declared")

# Figura 4 - falso alerta e deteccao (+10%, +25%, +50 tok) no holdout, estimador calibrado
fig, ax = plt.subplots(figsize=(7.5, 3.4))
keys = [("alertRate", "falso alerta"), ("det_plus10pct", "det. +10%"), ("det_plus25pct", "det. +25%"), ("det_plus50tok", "det. +50 tok")]
w = 0.26
for i, m in enumerate(MODELS):
    r = next(x for x in metrics if x["model"] == m and x["split"] == "holdout" and x["family"] == "all" and x["estimator"].startswith("CAL"))
    vals = [float(r[k]) * 100 for k, _ in keys]
    xs = [k + (i - 1) * w for k in range(len(keys))]
    ax.bar(xs, vals, width=w - 0.03, color=COLOR[m], label=m, edgecolor="none")
    for x, v in zip(xs, vals): ax.text(x, v + 1.5, f"{v:.1f}", ha="center", va="bottom", fontsize=6.5, color="#2b2b2a")
ax.axhline(5, color="#8a8a85", linewidth=0.8, linestyle=":", label="limite falso alerta 5%")
ax.axhline(50, color="#5c5c58", linewidth=0.8, linestyle="--", label="exigido det. +25%: 50%")
ax.set_xticks(range(len(keys))); ax.set_xticklabels([l for _, l in keys]); ax.set_ylabel("% das linhas do holdout"); ax.set_ylim(0, 112)
ax.legend(fontsize=7, loc="upper center", bbox_to_anchor=(0.5, -0.14), ncol=3)
ax.set_title("Holdout: falso alerta e poder de deteccao com os limiares congelados", fontsize=10, color="#2b2b2a")
save(fig, "fig4_holdout_alert_detection")
print("figuras:", sorted(os.listdir(a.out)))
