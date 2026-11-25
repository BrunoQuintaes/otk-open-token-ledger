#!/usr/bin/env bash
# Prints the enode URL of a Besu node, read with the admin_nodeInfo JSON-RPC method, without a newline.
# Called by besu_up_full.sh to wait until node1's P2P layer is ready and to build the bootnode for
# the other nodes. Needs Node.js 18+ (global fetch) and the ADMIN RPC API enabled on the node.
# Usage: bash scripts/ops/besu_get_enode.sh [rpc-url]   (default http://127.0.0.1:8545)
# Exit codes: 0 = enode printed on stdout; 2 = no enode in the reply, or the request failed.
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
