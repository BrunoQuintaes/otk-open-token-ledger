#!/usr/bin/env bash
set -euo pipefail
rpc="${1:-http://127.0.0.1:8545}"
node - "$rpc" <<'NODE'
const rpc = process.argv[2]; // argv[0]=node, argv[1]='-', argv[2]=URL
(async () => {
  const body = JSON.stringify({ jsonrpc:"2.0", id:1, method:"admin_nodeInfo", params:[] });
  const res = await fetch(rpc, { method:"POST", headers:{ "content-type":"application/json" }, body });
  const j = await res.json();
  if (!j.result || !j.result.enode) { console.error("FAIL: no enode in admin_nodeInfo"); process.exit(2); }
  process.stdout.write(j.result.enode);
})().catch(e=>{ console.error(e); process.exit(2); });
NODE
