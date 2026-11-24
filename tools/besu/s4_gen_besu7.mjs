/**
 * s4_gen_besu7.mjs — fresh, isolated 7-validator IBFT 2.0 network for the D1–D8 integration
 * (run 20260930-1625, S4). Writes ONLY into --out (outside the repository: keys never enter Git)
 * and never touches infra/ibft (historical 4/7-node configuration) or its volumes.
 *
 *   node tools/besu/s4_gen_besu7.mjs --out <HOME>/otk-exec-D1D8-20260930-1625/besu7-s4 \
 *        --subnet 172.31.210 --chain-id 16251
 *
 * Produces: nodeN/key (validator keys), dev/funder.key, dev/deployer.key, dev/operator.key,
 * dev/submitter.key (throwaway development keys of THIS network only), config/genesis.json,
 * config/static-nodes.json, network.json (addresses only) and docker-compose.yml (project --project, default
 * otk-d1d8-1625-besu7, subnet override, RPC of node1 on 127.0.0.1:<rpc>). Keys are never printed.
 */
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('--out', ''));
if (!arg('--out', '')) throw new Error('--out is required (outside the repository)');
const SUBNET = arg('--subnet', '172.31.210');
const CHAIN_ID = Number(arg('--chain-id', '16251'));
const RPC = Number(arg('--rpc', '58745'));
const N = 7;
const IMAGE = 'hyperledger/besu:25.12.0';
// compose project: the historical network keeps its default name; a new network MUST get its own (FECHAMENTO_GEMINI_AD C5)
const PROJECT = arg('--project', 'otk-d1d8-1625-besu7');
if (!/^[a-z0-9][a-z0-9_-]*$/.test(PROJECT)) throw new Error('--project must be a lowercase compose project name');
if (fs.existsSync(path.join(OUT, 'config', 'genesis.json'))) throw new Error(`${OUT} already has a network; refusing to overwrite`);

// INF01-F02 (OTK-MOR-01) + H1-S12 (OTK-H1-MEGA 2026-10-13): validator keys stay 0600 and are made readable by exactly
// the uid that runs Besu, instead of 0644 (readable by every user of the host). The image entrypoint
// (/opt/besu/bin/besu-entry.sh) runs Besu as the current uid when it is not root, and as root it fixes permissions and
// drops to `besu` (uid 1000), which cannot read a 0600 :ro bind mount owned by someone else.
//   - host uid 0 (cloud container, root CI): key chowned to 1000:1000, 0600; the image drops to besu as before;
//   - host uid > 0 (Linux user): containers run with user "<uid>:<gid>", key owned by that user, 0600; the data dir is a
//     bind mount nodeN/data owned by the same user (a named volume would be root-owned and unwritable);
//   - no uid (Windows / Docker Desktop, modes ignored): unchanged (0600 written, named volumes).
// --run-as <uid>:<gid> overrides the detected host uid (used by the test of the non-root path while running as root).
const BESU_UID = 1000;
const runAsArg = arg('--run-as', '');
if (runAsArg && !/^\d+:\d+$/.test(runAsArg)) throw new Error('--run-as must be <uid>:<gid>');
const HOST = runAsArg ? { uid: Number(runAsArg.split(':')[0]), gid: Number(runAsArg.split(':')[1]) }
  : (typeof process.getuid === 'function' ? { uid: process.getuid(), gid: process.getgid() } : null);
const RUN_AS_USER = HOST && HOST.uid !== 0 ? `${HOST.uid}:${HOST.gid}` : null;  // compose `user:` (null = image default)
const KEY_OWNER = !HOST ? null : HOST.uid === 0 ? { uid: BESU_UID, gid: BESU_UID } : { uid: HOST.uid, gid: HOST.gid };
const key = (p, owner = null) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const w = ethers.Wallet.createRandom();
  fs.writeFileSync(p, w.privateKey.slice(2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  // chown needs root unless the owner is the current user; only validator keys are mounted into the containers
  if (owner && typeof process.getuid === 'function' && (process.getuid() === 0 || owner.uid === process.getuid())) fs.chownSync(p, owner.uid, owner.gid);
  return w;
};
const nodes = [];
for (let i = 1; i <= N; i++) {
  const w = key(path.join(OUT, `node${i}`, 'key'), KEY_OWNER);
  if (RUN_AS_USER) {
    const d = path.join(OUT, `node${i}`, 'data');
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    if (process.getuid() === 0 || HOST.uid === process.getuid()) fs.chownSync(d, HOST.uid, HOST.gid);
  }
  const pub = new ethers.SigningKey(w.privateKey).publicKey.slice(4);
  const ip = `${SUBNET}.${10 + i}`;
  nodes.push({ node: i, address: w.address.toLowerCase(), ip, enode: `enode://${pub}@${ip}:30303?discport=0` });
}
const dev = Object.fromEntries(['funder', 'deployer', 'operator', 'submitter'].map((n) => [n, key(path.join(OUT, 'dev', `${n}.key`)).address]));
const validators = nodes.map((n) => n.address).sort();
const cfg = path.join(OUT, 'config');
fs.mkdirSync(cfg, { recursive: true });
fs.writeFileSync(path.join(cfg, 'toEncode.json'), JSON.stringify(validators, null, 2));
const extraData = execSync(`docker run --rm -v "${cfg.replace(/\\/g, '/')}:/config" ${IMAGE} rlp encode --from=/config/toEncode.json --type=IBFT_EXTRA_DATA`,
  { encoding: 'utf8', timeout: 60_000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
const alloc = {};
for (const a of [dev.funder, dev.deployer, dev.submitter, ...validators]) alloc[a.toLowerCase().replace(/^0x/, '')] = { balance: '0x21e19e0c9bab2400000' };
const genesis = {
  config: { chainId: CHAIN_ID, ibft2: { requesttimeoutseconds: 10, blockperiodseconds: 2, epochlength: 30000 }, londonBlock: 0, berlinBlock: 0 },
  nonce: '0x0', timestamp: '0x0', extraData, gasLimit: '0x5F5E100', difficulty: '0x1',
  mixHash: '0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365', coinbase: '0x0000000000000000000000000000000000000000', alloc,
};
fs.writeFileSync(path.join(cfg, 'genesis.json'), JSON.stringify(genesis, null, 2));
fs.writeFileSync(path.join(cfg, 'static-nodes.json'), JSON.stringify(nodes.map((n) => n.enode), null, 2));
fs.writeFileSync(path.join(OUT, 'network.json'), JSON.stringify({ schema: 'otk.s4_besu7.v1', project: PROJECT, chainId: CHAIN_ID, subnet: `${SUBNET}.0/24`, rpc: `http://127.0.0.1:${RPC}`, validators, nodes: nodes.map(({ node, address, ip }) => ({ node, address, ip })), dev, image: IMAGE, generatedAt: new Date().toISOString() }, null, 2));

const svc = (n) => `  node${n.node}:
    image: ${IMAGE}
    restart: "no"
    mem_limit: 640m
    environment:
      BESU_OPTS: "-Xmx320m"
    networks:
      besu7:
        ipv4_address: ${n.ip}
${RUN_AS_USER ? `    user: '${RUN_AS_USER}'\n` : ''}${n.node === 1 ? `    ports:\n      - '127.0.0.1:${RPC}:8545'\n` : ''}    volumes:
      - './config/genesis.json:/config/genesis.json:ro'
      - './config/static-nodes.json:/config/static-nodes.json:ro'
      - './node${n.node}/key:/keys/key:ro'
      - '${RUN_AS_USER ? `./node${n.node}/data` : `data${n.node}`}:/data'
    command:
      - --genesis-file=/config/genesis.json
      - --network-id=${CHAIN_ID}
      - --data-path=/data
      - --node-private-key-file=/keys/key
      - --rpc-http-enabled=true
      - --rpc-http-host=0.0.0.0
      - --rpc-http-api=ETH,NET,WEB3,IBFT,TXPOOL
      - --host-allowlist=*
      - --discovery-enabled=false
      - --p2p-host=${n.ip}
      - --p2p-port=30303
      - --static-nodes-file=/config/static-nodes.json
      - --min-gas-price=0
`;
fs.writeFileSync(path.join(OUT, 'docker-compose.yml'), `# Generated by tools/besu/s4_gen_besu7.mjs (run 20260930-1625, S4). Isolated: own project, subnet, volumes.
name: ${PROJECT}
networks:
  besu7:
    driver: bridge
    ipam:
      config:
        - subnet: ${SUBNET}.0/24
${RUN_AS_USER ? '' : `volumes:\n${nodes.map((n) => `  data${n.node}:`).join('\n')}\n`}
services:
${nodes.map(svc).join('')}`);
console.log(JSON.stringify({ out: OUT, chainId: CHAIN_ID, subnet: `${SUBNET}.0/24`, validators: validators.length, rpc: RPC, dev }, null, 2));
