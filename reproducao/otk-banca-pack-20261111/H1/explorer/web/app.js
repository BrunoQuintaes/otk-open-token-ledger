'use strict';
// Explorador estatico, somente leitura (rev. 2). Sem rede (CSP connect-src 'none'), sem armazenamento, sem escrita. Dados em window.H1DATA.
(function () {
  const D = window.H1DATA || {};
  const OV = D.overview, IDX = D.index, DET = D.detail, PROMPTS = D.prompts, DEN = D.denominators, MET = D.metrics, CAL = D.cal;
  const app = document.getElementById('app');
  const SHORT = OV.baseline.slice(0, 8);
  const fileByPath = new Map(OV.files.map((f) => [f.path, f]));
  const byId = new Map(DET.map((d) => [d.id, d]));

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const usd = (n) => (n === null || n === undefined ? 'n/d' : `US$ ${Number(Number(n).toFixed(8))}`);
  const nf = (n) => (n === null || n === undefined ? 'n/d' : String(n));
  const pct = (x) => (x === null || x === undefined ? 'n/d' : `${(x * 100).toFixed(1)}%`);
  const base = (p) => p.split('/').pop();
  const card = (k, v, l) => h('div', { class: 'card' }, h('div', { class: 'v', 'data-k': k, text: String(v) }), h('div', { class: 'l', text: l }));
  const table = (head, rows, numCols = []) => h('table', {}, h('thead', {}, h('tr', {}, head.map((t, i) => h('th', { class: numCols.includes(i) ? 'n' : '', text: t })))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: numCols.includes(i) ? 'n' : '' }, c))))));
  const opLink = (opId, text) => (opId ? h('a', { href: `#/op/${encodeURIComponent(opId)}`, text }) : text);
  const shaOf = (file) => (fileByPath.get(file) || {}).sha256;
  const splitText = (d) => (d.split ? (d.splitRaw === 'test' ? 'holdout (meta.split=test)' : d.split) : '—');

  // ---------- 1. visao geral ----------
  function overview() {
    const t = OV.totals;
    return h('div', {}, h('h1', { text: 'Visão geral da campanha de 07/10/2026' }),
      h('div', { class: 'cards' }, card('operations', t.operations, 'operações (R02: inventory_662.jsonl)'), card('completed', t.completed, 'concluídas (HTTP 200)'), card('refused', t.refused, 'recusadas antes de haver uso'), card('pairs', t.pairs, 'pares de calibração (denominador da calibração)'), card('cost', usd(t.costRecomputedUsd), 'custo CALCULADO (tabela congelada, não é fatura)')),
      h('div', { class: 'note', text: `${OV.costLabel} ${OV.corpus.note}. ${OV.splitNote}` }),
      h('h2', { text: 'Por provedor / modelo devolvido' }),
      table(['Provedor / modelo', 'Concluídas', 'Pares de calibração', 'Custo calculado (tabela congelada, não é fatura)', 'Conferência (estado → nº)'],
        OV.byModel.map((m) => [h('span', { 'data-k': 'model', text: m.key }), h('span', { 'data-k': 'model-completed', 'data-model': m.key, text: String(m.completed) }), String(m.pairs), usd(m.costRecomputedUsd), Object.entries(m.conference).map(([k, v]) => `${k}: ${v}`).join(' · ')]), [1, 2, 3]),
      h('h2', { text: 'Recusadas (sem uso, custo 0)' }),
      table(['Operação', 'Provedor', 'HTTP', 'Motivo (resumo)'], OV.refused.map((r) => [opLink(r.id, r.label), r.provider, String(r.http), r.error.slice(0, 110)])),
      h('h2', { text: 'Operações por família e provedor' }),
      table(['Família', 'anthropic', 'gemini', 'openai'], OV.familyByProvider.map((f) => [f.family, nf(f.perProvider.anthropic), nf(f.perProvider.gemini), nf(f.perProvider.openai)]), [1, 2, 3]),
      h('div', { class: 'note' }, h('span', { class: 'tag syn', text: 'SINTÉTICO' }), ` ${OV.syntheticExcluded.calls} chamadas de gate sintético existem na árvore e `, h('b', { text: 'não' }), ' estão nas 662 operações nem em nenhuma contagem desta tela.'),
      h('h2', { text: 'Arquivos de origem (baseline ' + SHORT + ' e runs R02–R05)' }),
      table(['Caminho', 'Origem', 'Linhas', 'sha256'], OV.files.map((f) => [h('span', { class: 'mono', text: f.path }), f.label, String(f.lines), h('span', { class: 'mono', text: f.sha256 })]), [2]));
  }

  // ---------- 2. lista de operacoes ----------
  const uniq = (f) => [...new Set(IDX.map(f).filter((x) => x !== null && x !== undefined))].sort();
  const verdictOf = (o) => (o.completed ? `${o.state} / ${o.verdict}` : 'recusada');
  let shown = 200;
  function opsList(q) {
    const f = Object.fromEntries(new URLSearchParams(q || ''));
    const sel = (name, label, opts) => h('label', {}, label, h('select', { 'data-f': name, onchange: apply }, h('option', { value: '', text: 'todos' }), opts.map((o) => h('option', { value: o, text: o, selected: f[name] === o ? 'selected' : false }))));
    const search = h('input', { type: 'text', 'data-f': 'q', placeholder: 'rótulo ou id', value: f.q || '', oninput: apply });
    const count = h('strong', { 'data-k': 'filtered' });
    const tbody = h('tbody', {});
    const more = h('button', { onclick: () => { shown += 200; render(); }, text: 'mostrar mais' });
    function apply() { shown = 200; render(); }
    function cur() { const o = {}; document.querySelectorAll('[data-f]').forEach((e) => { o[e.getAttribute('data-f')] = e.value; }); return o; }
    function render() {
      const c = cur();
      const rows = IDX.filter((o) => (!c.provider || o.provider === c.provider) && (!c.family || o.family === c.family) && (!c.split || o.split === c.split) && (!c.verdict || verdictOf(o) === c.verdict) && (!c.q || o.id.includes(c.q) || o.label.includes(c.q)));
      count.textContent = `${rows.length}`; count.setAttribute('data-count', String(rows.length));
      tbody.replaceChildren(...rows.slice(0, shown).map((o) => h('tr', { class: 'row', 'data-id': o.id, onclick: () => { location.hash = `#/op/${encodeURIComponent(o.id)}`; } }, [h('td', { text: o.label }), h('td', { text: o.provider }), h('td', { text: o.model || '—' }), h('td', { text: o.family || '—' }), h('td', { text: o.split || '—' }), h('td', {}, h('span', { class: 'tag ' + (o.completed ? 'ok' : 'bad'), text: verdictOf(o) })), h('td', { class: 'n', text: usd(o.costUsd) })])));
      more.style.display = rows.length > shown ? '' : 'none';
    }
    const el = h('div', {}, h('h1', { text: 'Operações' }),
      h('div', { class: 'filters' }, sel('provider', 'Provedor', uniq((o) => o.provider)), sel('family', 'Família', uniq((o) => o.family)), sel('split', 'Divisão (split; test = holdout)', uniq((o) => o.split)), sel('verdict', 'Veredito da conferência', [...new Set(IDX.map(verdictOf))].sort()), h('label', {}, 'Busca', search), h('span', {}, 'Mostrando ', count, ` de ${IDX.length}`)),
      h('table', {}, h('thead', {}, h('tr', {}, ['Rótulo', 'Provedor', 'Modelo devolvido', 'Família', 'Split', 'Veredito', 'Custo calculado (tabela congelada)'].map((t) => h('th', { text: t })))), tbody), more);
    queueMicrotask(render);
    return el;
  }

  // ---------- 3. uma operacao ----------
  function opPage(id) {
    const d = byId.get(id);
    if (!d) return h('p', { text: 'Operação não encontrada nesta baseline.' });
    const o = d.origin;
    const inv = (jp) => ({ file: o.sourceFile, line: o.sourceLine, path: jp, via: `R02 inventory_662.jsonl:${o.inventoryLine}`, sha: o.sourceSha256 });
    const man = (jp) => ({ file: o.manifestFile, line: null, path: jp });
    const r05 = (jp) => ({ file: `runs/${'R05/data/pairs_633.csv'}`, line: d.calibrated ? d.calibrated.line : null, path: jp });
    const r03 = (jp) => ({ file: d.prompt ? d.prompt.r03File : null, line: d.prompt ? d.prompt.r03Line : null, path: jp });
    const derived = (txt) => ({ derived: txt });
    const prof = MET.profiles.find((p) => p.model === d.model);
    const pr = d.prompt;
    const promptCell = pr ? h('div', {}, h('span', { class: 'tag ok', 'data-k': 'prompt-proof', text: pr.provenByHash ? 'prompt planejado comprovado por hash' : 'hash NÃO comprovado' }), ' ', h('span', { class: 'pending', text: 'corpo enviado não registrado no log' }), h('pre', { class: 'prompt', 'data-k': 'prompt-text', text: PROMPTS[pr.key] })) : h('span', { class: 'pending', text: 'sem prompt planejado' });
    const usage = d.usageDeclared ? d.usageDeclared.map((u) => `${u.name}=${u.count === null ? 'n/d' : u.count} (${u.sourceField})`).join('; ') : 'n/d';
    const rows = [
      ['Provedor', d.provider, inv('provider')],
      ['Modelo devolvido', d.model || 'n/d (recusada antes de haver uso)', inv('model_returned')],
      ['Família · grupo · split · tamanho · docId', [d.family, d.group, splitText(d), d.sizeBucket, d.docId].map((x) => x || '—').join(' · '), inv('meta')],
      ['Texto / prompt PLANEJADO (R03)', promptCell, pr ? r03('prompt') : null],
      ['Hash do prompt planejado · caracteres (= manifesto da execução)', pr ? `${pr.sha256} · ${pr.chars} car. · manifesto ${pr.manifestSha256 === pr.sha256 ? 'igual' : 'DIFERENTE'}` : 'n/d', pr ? man(`plannedCalls[${o.plannedIndex}].promptSha256`) : null],
      ['Contagem local do OTK (entrada · saída, tokens)', `${nf(d.local.input)} · ${nf(d.local.output)}`, inv('conference.comparisons[].local')],
      ['Uso declarado pelo provedor (entrada · saída, tokens)', `${nf(d.declared.input)} · ${nf(d.declared.output)}`, inv('usage declarado')],
      ['Diferença (declarado − local; entrada · saída)', `${nf(d.diff.input)} · ${nf(d.diff.output)}`, inv('diff_input_declared_minus_local')],
      ['Estimativa calibrada (entrada) - recomputada no R05', d.calibrated ? `${d.calibrated.pred} (erro bruto ${d.calibrated.errRaw}; erro calibrado ${d.calibrated.errCal}; alerta bruto ${d.calibrated.alertRaw}; alerta calibrado ${d.calibrated.alertCal}) · perfil ${prof ? (prof.calibrated ? 'ACEITO (calibrated=true)' : 'NÃO aceito (calibrated=false)') : 'n/d'}; round_half_up, parâmetros congelados` : 'n/d (fora dos 633 pares)', d.calibrated ? r05('pred_calibrated') : null],
      ['Par de calibração', d.pair ? `${d.pair}${d.excludedReason ? ' · ' + d.excludedReason : ''}` : 'n/d', inv('in_calibration_pairs')],
      ['Uso declarado, categorias (OTK)', usage, inv('otkUsageCategories')],
      ['Saída', d.output ? `${d.output.chars} car. · sha256 ${d.output.sha256} (o texto da resposta não é armazenado)` : 'n/d', inv('responseChars, responseTextSha256')],
      ['Reserva conservadora (teto de segurança, não previsão)', usd(d.reserveUsd), inv('ledgerReservation.reservedUsd')],
      ['Custo calculado (tabela congelada, não é fatura)', `${usd(d.cost.recomputed === null ? null : Number(d.cost.recomputed))} (razão: ${usd(d.cost.ledgerUsd)}; recálculo × razão: ${d.cost.vsLedger || 'n/d'})${d.cost.note ? ' · ' + d.cost.note : ''}`, inv('costUsd_recomputed_frozen_table_NOT_INVOICE')],
      ['Estado da conferência', d.conference ? `${d.conference.state} / ${d.conference.verdict}` : 'n/d', inv('conference')],
      ['Digest do recibo', d.receiptDigest || 'n/d', inv('conference.receiptDigest')],
      ['Digest da conferência', d.conferenceDigest || 'n/d', inv('conference.digest')],
      ['Instante no log (não é o da chamada)', d.tsLog ? `${d.tsLog} · ${d.tsSource.slice(0, 150)}` : 'n/d (sem evento no log)', inv('ts_log_utc')],
      ['HTTP · latência · erro', `${d.http} · ${d.latencyMs === null ? 'n/d' : d.latencyMs + ' ms'}${d.error ? ' · ' + d.error.slice(0, 120) : ''}`, inv('httpStatus, latencyMs, error')],
      ['Execução (commit do código)', d.manifestCommit ? d.manifestCommit.slice(0, 12) : 'n/d', man('commit')],
      ['Tabela de preços (versão · sha256)', `${d.priceTable.version} · ${d.priceTable.sha256}`, man('priceTable')],
    ];
    if (d.notes) rows.push(['Notas do inventário', d.notes, inv('notes')]);
    const originCell = (src) => {
      if (!src) return h('span', { class: 'origin', text: 'sem número de origem (texto/aviso)' });
      if (src.derived) return h('span', { class: 'origin' }, h('span', { class: 'tag', text: 'DERIVADO' }), ` ${src.derived}`);
      const sha = src.sha || shaOf(src.file);
      const tail = src.file.startsWith('runs/') ? '' : ` · baseline ${SHORT}`;
      return h('span', { class: 'origin', title: src.file }, `${base(src.file)}${src.line ? ':' + src.line : ''} › ${src.path}${src.via ? ' (via ' + src.via + ')' : ''} · sha256 ${sha ? sha.slice(0, 12) : 'n/d'}…${tail}`);
    };
    const srcFiles = [[o.sourceFile, o.sourceLine], [o.manifestFile, null], ['runs/R02/inventory_662.jsonl', o.inventoryLine], ...(pr ? [[pr.r03File, pr.r03Line]] : []), ...(d.calibrated ? [['runs/R05/data/pairs_633.csv', d.calibrated.line]] : [])].filter(([f]) => f);
    return h('div', {}, h('p', {}, h('a', { href: '#/ops', text: '← operações' })), h('h1', { text: d.label }),
      h('div', { class: 'note' }, 'ID completo: ', h('span', { class: 'mono', 'data-k': 'op-id', text: d.id }), ' · ', h('span', { class: 'tag ' + (d.completed ? 'ok' : 'bad'), text: d.completed ? 'concluída' : 'recusada' }), ' · fase: ' + d.phase),
      h('table', { 'data-k': 'op-table' }, h('thead', {}, h('tr', {}, ['Campo', 'Valor', 'Origem (arquivo:linha › campo · sha256 · baseline)'].map((t) => h('th', { text: t })))),
        h('tbody', {}, rows.map(([label, value, src]) => h('tr', { 'data-field': label }, h('td', { text: label }), h('td', { class: 'mono' }, value), h('td', {}, originCell(src)))))),
      h('h2', { text: 'Fontes desta operação (conferir)' }),
      table(['Arquivo', 'Linha', 'sha256 do arquivo', 'Como conferir'], srcFiles.map(([f, l]) => [h('span', { class: 'mono', text: f }), l ? String(l) : '—', h('span', { class: 'mono', text: shaOf(f) || 'n/d' }), h('span', { class: 'mono', text: f.startsWith('runs/') ? 'arquivo do run (sha256 acima)' : `git show ${OV.baseline}:${f}` })]), [1]));
  }

  // ---------- 5. denominadores (R04) ----------
  function denominators() {
    const provs = Object.keys(DEN.providers);
    const list = (title, items, fmt) => h('div', {}, h('h3', { text: title }), h('ul', {}, items.map((it) => h('li', {}, fmt(it)))));
    return h('div', {}, h('h1', { text: 'Denominadores: de 662 linhas a 633 pares (R04)' }),
      h('div', { class: 'note', text: 'Dois denominadores distintos, sem dupla contagem: COLETA (custo, tokens declarados) = 658 realizadas; CALIBRAÇÃO (perfis e métricas) = 633 pares. Cada operação sai em exatamente um passo (partição verificada pelo R04). As 4 recusas não estão em nenhum dos dois.' }),
      table(['Provedor', 'S0 linhas', 'S1 realizadas (HTTP 200)', 'S2 com conferência capturada', 'S3 pares de calibração', 'train / validation / holdout', 'grupos no holdout'],
        provs.map((p) => { const v = DEN.providers[p]; return [h('span', { 'data-k': 'den-provider', text: p }), h('span', { 'data-k': 'den-S0', 'data-p': p, text: String(v.S0) }), h('span', { 'data-k': 'den-S1', 'data-p': p, text: String(v.S1) }), h('span', { 'data-k': 'den-S2', 'data-p': p, text: String(v.S2) }), h('span', { 'data-k': 'den-S3', 'data-p': p, text: String(v.S3) }), `${v.S4.train} / ${v.S4.validation} / ${v.S4.holdout}`, String(v.groupsHoldout)]; }), [1, 2, 3, 4, 6]),
      h('div', { class: 'note', text: `Totais do R04: ${DEN.totais.linhas} linhas · ${DEN.totais.realizadas} realizadas · ${DEN.totais.pares} pares · ${DEN.totais.excluidas_nominais} exclusões nominais. Regra de split: sha256 do grupo mod 100 (<60 train, <80 validation, senão holdout); meta.split=test é o holdout.` }),
      provs.map((p) => { const v = DEN.providers[p]; return h('div', {}, h('h2', { text: `${p}: ${v.chain}` }),
        list('S0 → S1: recusadas', v.S1out, (it) => [opLink(it.opId, it.label), ` · HTTP ${it.httpStatus} · ${it.split}/${it.family} · repetida depois: ${it.repetida_depois}`]),
        list('S1 → S2: concluídas sem conferência capturada (not_produced)', v.S2out, (it) => [opLink(it.opId, it.label), ` · ${it.split}/${it.family} · ${it.conference_state}`]),
        h('h3', { text: 'S2 → S3: fora do escopo do perfil' }), h('p', { text: `${v.S3cache.join('; ')} · ${v.S3besu.join('; ')}` }),
        h('h3', { text: `Pares por split × família (${p})` }),
        table(['split', ...Object.keys(v.S4family.train), 'total'], Object.entries(v.S4family).map(([s, fm]) => [s, ...Object.values(fm).map(String), String(Object.values(fm).reduce((a, b) => a + b, 0))]), [1, 2, 3, 4, 5, 6, 7, 8, 9])); }),
      h('h2', { text: 'mixed_unicode-000-v1 (exclusão pré-declarada)' }), h('ul', {}, Object.entries(DEN.mixed).map(([p, t]) => h('li', { text: `${p}: ${t}` }))),
      h('p', { class: 'origin', text: `Origem: runs/R04/denominators.json · sha256 ${shaOf('runs/R04/denominators.json') || 'n/d'} · inventário R02 ${DEN.inventory.sha256} · baseline ${SHORT}` }));
  }

  // ---------- 4. metricas (R05) ----------
  function metrics() {
    const rows = MET.rows;
    const get = (model, split, family, est) => rows.find((r) => r.model === model && r.split === split && r.family === family && r.estimator === est);
    const models = [...new Set(rows.map((r) => r.model))];
    const EST = { RAW_local_heuristic_v0: 'bruto (limiar v0)', CALIBRATED_frozen_profile: 'calibrado (perfil congelado)' };
    const line = (r) => [r.model, r.split, EST[r.estimator], String(r.n), String(r.groups), nf(r.bias), nf(r.mae), nf(r.rmse_NEW), nf(r.maxAbs), pct(r.alertRate), pct(r.det_plus25pct)];
    const t1 = []; for (const m of models) for (const s of ['train', 'validation', 'holdout']) for (const e of Object.keys(EST)) { const r = get(m, s, 'all', e); if (r) t1.push(line(r)); }
    const fams = [...new Set(rows.map((r) => r.family).filter((f) => f !== 'all'))];
    const famTable = (split) => { const t = []; for (const m of models) for (const f of fams) { const r = get(m, split, f, 'CALIBRATED_frozen_profile'); if (r) t.push([m, f, String(r.n), nf(r.bias), nf(r.mae), nf(r.rmse_NEW), nf(r.maxAbs), pct(r.alertRate), pct(r.det_plus25pct)]); } return t; };
    const head2 = ['Modelo', 'Família', 'n', 'viés', 'MAE', 'RMSE', 'máx.', 'falso alerta', 'detecção +25%'];
    return h('div', {}, h('h1', { text: 'Métricas por modelo, split e família (R05, recomputadas)' }),
      h('div', { class: 'note', text: 'Números do R05 (MET-02): recomputo independente com parâmetros e limiares CONGELADOS dos perfis originais; todos os campos conferidos contra os perfis = REPRODUZIDO. Alvo = uso DECLARADO pelo provedor. RMSE é métrica nova, rotulada. Nada foi reajustado.' }),
      h('h2', { text: 'Reprodução frente aos perfis originais' }),
      table(['Modelo', 'train', 'validation', 'holdout', 'calibrated (perfil original)'], Object.entries(MET.verdicts).map(([m, v]) => { const p = MET.profiles.find((x) => x.model === m); return [m, v.splits.train, v.splits.validation, v.splits.holdout, h('span', { class: 'tag ' + (p.calibrated ? 'ok' : 'bad'), text: String(p.calibrated) })]; })),
      h('h2', { text: 'Por modelo e split (todas as famílias)' }),
      table(['Modelo', 'Split', 'Estimador', 'n', 'grupos', 'viés', 'MAE', 'RMSE', 'máx.', 'falso alerta', 'detecção +25%'], t1, [3, 4, 5, 6, 7, 8]),
      h('h2', { text: 'Por modelo e família (todos os splits; estimador calibrado)' }), table(head2, famTable('all'), [2, 3, 4, 5, 6]),
      h('h2', { text: 'Por modelo e família no HOLDOUT (descritivo, n pequeno)' }),
      h('div', { class: 'note', 'data-k': 'holdout-fam-note', text: 'Descritivo, n pequeno: cada célula tem poucos pares (veja n); não há inferência por família no holdout.' }),
      table(head2, famTable('holdout'), [2, 3, 4, 5, 6]),
      h('h2', { text: 'Figuras do R05' }), h('div', { class: 'figs' }, MET.figures.map((f) => h('figure', {}, h('img', { class: 'fig', src: f.file, alt: f.name }), h('figcaption', { class: 'origin', text: `${f.path} · sha256 ${f.sha256.slice(0, 12)}…` })))),
      h('h2', { text: 'Checagens de aceite dos perfis originais (H1)' }),
      MET.profiles.map((x) => h('details', {}, h('summary', { text: `${x.model} · aceite ${x.acceptancePassed ? 'passou' : 'não passou'} · ${x.file.split('/').pop()}` }), table(['Checagem', 'Exigido', 'Observado', 'Passou'], x.acceptance.map((c) => [c.id, c.required, c.observed, h('span', { class: 'tag ' + (c.passed ? 'ok' : 'bad'), text: c.passed ? 'sim' : 'não' })])), h('p', { class: 'origin', text: `evidenceHash ${x.evidenceHash} · sha256 do arquivo ${shaOf(x.file) || 'n/d'} · baseline ${SHORT}` }))),
      h('p', { class: 'origin', text: `Origem: runs/R05/data/metrics_long.json · sha256 ${shaOf('runs/R05/data/metrics_long.json') || 'n/d'}; comparação: runs/R05/comparison.json · sha256 ${shaOf('runs/R05/comparison.json') || 'n/d'}` }));
  }

  // ---------- 6. CAL-ANTH-01 (suplementar) ----------
  function calTab() {
    return h('div', { 'data-k': 'cal-tab' }, h('div', { class: 'calbar', 'data-k': 'cal-label', text: CAL.label }),
      h('h1', { text: 'CAL-ANTH-01: números do relatório de verificação independente' }),
      h('div', { class: 'note', text: 'Campanha SUPLEMENTAR e POSTERIOR à H1: não é a H1, não revoga o resultado de 07/10 e não se mistura com as telas anteriores. Fonte única desta aba: CAL_ANTH_VERIFY (relatório e RECOMPUTE_RESULTS.json), recálculo independente; custo CALCULADO pela tabela congelada (não é fatura).' }),
      h('div', { class: 'cards' }, card('cal-calls', CAL.totals.callsTotal, 'chamadas (1.197 + 5 E2E)'), card('cal-valid', CAL.totals.valid, 'válidas'), card('cal-refusals', CAL.totals.refusalsWithUsage, 'recusas com uso de entrada'), card('cal-cost', `US$ ${CAL.totals.costTotalUsd}`, 'custo CALCULADO (não é fatura)')),
      h('h2', { text: 'Por modelo (holdout de 72 textos / 24 grupos)' }),
      table(['Modelo', 'Treino / val. / holdout', 'Ajuste afim', 'Limiar (tokens · relativo)', 'MAE', 'Falso alerta', 'Detecção +25%', 'Veredito (relatório)'],
        CAL.models.map((m) => [m.model, `${m.n.train} / ${m.n.validation} / ${m.n.holdout}`, `${m.fit.slope} × local + ${m.fit.intercept}`, `${m.threshold.abs} · ${m.threshold.rel}`, nf(m.holdout.mae), `${m.holdout.falseAlarms}/${m.holdout.n} (${pct(m.holdout.falseAlarmRate)})`, pct(m.holdout.detection['+25%']), m.verdict]), [4]),
      h('h2', { text: 'Perfil de 07/10 aplicado ao holdout novo (descritivo)' }),
      h('p', { text: `Haiku 4.5, parâmetros ${CAL.historicalHaiku45OnNewHoldout.parametersUsed.slope} × local + ${CAL.historicalHaiku45OnNewHoldout.parametersUsed.intercept}: falso alerta ${CAL.historicalHaiku45OnNewHoldout.metrics.falseAlarms}/72, detecção +25% ${pct(CAL.historicalHaiku45OnNewHoldout.metrics.detection['+25%'])}, MAE ${CAL.historicalHaiku45OnNewHoldout.metrics.mae}. Só descritivo.` }),
      h('p', { text: `Tokenizador compartilhado: Haiku 5.5 = Sonnet 5.5 em ${CAL.sharedTokenizer.haikuEqSonnet}; Opus = Haiku + 2 em ${CAL.sharedTokenizer.opusEqHaikuPlus2}.` }),
      h('h2', { text: 'O que se pode e não se pode afirmar' }),
      h('ul', {}, h('li', {}, h('b', { text: 'Pode: ' }), CAL.limits.can), h('li', {}, h('b', { text: 'Não pode: ' }), CAL.limits.cannot)),
      h('div', { class: 'note', text: CAL.cal02 }),
      h('p', { class: 'origin', text: `Origem: ${CAL.limits.source}; runs/CAL_ANTH_VERIFY/RECOMPUTE_RESULTS.json sha256 ${shaOf('runs/CAL_ANTH_VERIFY/RECOMPUTE_RESULTS.json') || 'n/d'}; relatório sha256 ${shaOf('runs/CAL_ANTH_VERIFY/CAL_ANTH_VERIFICATION_REPORT.md') || 'n/d'}; campanha: ${CAL.branch} @ ${CAL.commit} (${CAL.collected}). Não é a baseline H1.` }));
  }

  // ---------- roteador ----------
  function route() {
    const hash = location.hash || '#/';
    const [path, query] = hash.slice(1).split('?');
    let view, nav;
    if (path.startsWith('/op/')) { view = opPage(decodeURIComponent(path.slice(4))); nav = 'ops'; }
    else if (path === '/ops') { view = opsList(query); nav = 'ops'; }
    else if (path === '/denominators') { view = denominators(); nav = 'denominators'; }
    else if (path === '/metrics') { view = metrics(); nav = 'metrics'; }
    else if (path === '/cal') { view = calTab(); nav = 'cal'; }
    else { view = overview(); nav = 'overview'; }
    app.replaceChildren(view);
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('data-nav') === nav));
    window.scrollTo(0, 0);
    window.__H1_READY = path;
  }
  window.addEventListener('hashchange', route);
  route();
})();
