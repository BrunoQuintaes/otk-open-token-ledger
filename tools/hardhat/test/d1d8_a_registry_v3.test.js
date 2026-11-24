/**
 * D1-G01..G06, D2-G03 (on-chain part), D6-G02 — ReceiptRegistryV3 / BatchRegistryV3 with REAL
 * Groth16 proofs from the metering_v3 demonstrative artifacts, on the in-process Hardhat network
 * (front A, run 20260930-1625). No mock verifier. The TypeScript modules under test are loaded
 * with tsx (tsImport), so the same code C will call produces the signatures and proofs.
 *
 *   cd tools/hardhat && node --test test/d1d8_a_registry_v3.test.js
 *
 * Hardhat is the local gate of A; the Besu run is S4's integrated gate.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import hre from 'hardhat';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const { tsImport } = await import(pathToFileURL(path.join(ROOT, 'node_modules/tsx/dist/esm/api/index.mjs')).href);
const v3 = await tsImport(pathToFileURL(path.join(ROOT, 'src/zk/v3/index.ts')).href, import.meta.url);
const fx = await tsImport(pathToFileURL(path.join(ROOT, 'test/fixtures/d1d8/a/receiptFixture.ts')).href, import.meta.url);
const vec = await tsImport(pathToFileURL(path.join(ROOT, 'test/fixtures/d1d8/a/v3Vectors.ts')).href, import.meta.url);
const VECTORS = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/d1d8/a/v3_vectors.json'), 'utf8'));
const { ethers: E } = await import(pathToFileURL(path.join(ROOT, 'node_modules/ethers/lib.esm/index.js')).href);

const M = JSON.parse(readFileSync(path.join(ROOT, 'zk/v3/MANIFEST.json'), 'utf8'));
const CIRCUIT = M.circuitId;
const POLICY = v3.PUBLIC_BUCKET_POLICY_FIXED_1000CU;
const W = POLICY.widthUnits;
const ART = {
  circuitId: CIRCUIT,
  wasmPath: path.join(ROOT, 'zk/v3/build/metering_v3_js/metering_v3.wasm'),
  zkeyPath: path.join(ROOT, 'zk/v3/keys/metering_v3_demo_final.zkey'),
  vkeyPath: path.join(ROOT, 'zk/v3/keys/metering_v3_demo_vkey.json'),
  expected: Object.fromEntries([['wasm', 'zk/v3/build/metering_v3_js/metering_v3.wasm'], ['zkey', 'zk/v3/keys/metering_v3_demo_final.zkey'], ['vkey', 'zk/v3/keys/metering_v3_demo_vkey.json']].map(([k, f]) => [k, `0x${M.files[f]}`])),
};
const gas = {};

describe('ReceiptRegistryV3 + BatchRegistryV3 (real proofs, Hardhat in-process)', () => {
  let conn, ethers, deployer, attacker, relayer, operator, stranger, ring, adapter, build, buildBatch;
  let verifier, registry, batchReg, domain, batchDomain, chainId;
  let opCounter = 0;

  async function newAuth({ cuUnits = 640n, registryDomain = domain, wallet = operator, keyId = 'op-1', keyRing = ring, circuitId = CIRCUIT, narrow = false } = {}) {
    const r = fx.receiptFixture({ circuitId, cuUnits, operationId: `op-${++opCounter}` });
    const opening = v3.newCommitmentOpening(r.key, r.cu.cu, circuitId, { userRef: r.userRef, epoch: v3.epochOf(r.timing.admittedAt).toString() });
    r.publicCommitment = await v3.commitmentOf(opening);
    const b = v3.createPublicAuthorizationBuilder({ keyRing, signer: { keyId, wallet }, policy: POLICY, circuitId });
    const auth = await b({ receipt: r, opening, domain: registryDomain, bucket: v3.bucketForReceipt(r, POLICY) });
    if (narrow) {
      // Operator-signed narrow window (would reveal usage): signature valid, contract must refuse.
      const vals = { ...v3.authorizationValues(auth), minUsage: cuUnits * 1_000_000n, maxUsage: cuUnits * 1_000_000n };
      auth.bucket = { ...auth.bucket, min: vals.minUsage, max: vals.maxUsage };
      auth.fields = auth.fields.map((f) => (f.name === 'minUsage' || f.name === 'maxUsage' ? { ...f, value: String(vals[f.name]) } : f));
      auth.authorizationDigest = v3.authorizationDigest(registryDomain, vals);
      auth.signature = { ...auth.signature, payloadDigest: auth.authorizationDigest, signature: await wallet.signTypedData(v3.typedDomain(registryDomain, v3.REGISTRY_V3_NAME), v3.AUTHORIZATION_TYPES, vals) };
    }
    const bundle = await adapter.prove(adapter.buildWitnessInput(opening, auth));
    return { r, opening, auth, bundle };
  }

  const call = (sub) => sub.args;
  const tuple = (auth) => call(adapter.encodeSubmission(auth, { circuitId: CIRCUIT, proof: { a: ['0', '0'], b: [['0', '0'], ['0', '0']], c: ['0', '0'] }, publicSignals: [auth.commitment, String(auth.epoch), String(auth.bucket.min), String(auth.bucket.max)], artifacts: adapter.artifacts }))[0];

  async function expectRevert(p, name) {
    await assert.rejects(p, (e) => {
      const s = [e?.revert?.name, e?.shortMessage, e?.message, String(e)].filter(Boolean).join(' | ');
      if (!s.includes(name)) throw new Error(`expected ${name}, got: ${s.slice(0, 300)}`);
      return true;
    });
  }

  before(async () => {
    conn = await hre.network.connect();
    ethers = conn.ethers;
    [deployer, attacker, relayer] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;
    operator = E.Wallet.createRandom();
    stranger = E.Wallet.createRandom();
    ring = v3.createKeyRing([{ keyId: 'op-1', address: operator.address, status: 'active' }]);
    adapter = await v3.createProofAdapterV3(ART);

    verifier = await (await ethers.getContractFactory('MeteringVerifierV3Demo')).deploy();
    const RegF = await ethers.getContractFactory('ReceiptRegistryV3');
    registry = await RegF.deploy(await verifier.getAddress(), operator.address, v3.circuitIdHash(CIRCUIT), v3.bucketPolicyId(POLICY), W);
    batchReg = await (await ethers.getContractFactory('BatchRegistryV3')).deploy(operator.address);
    domain = { chainId, registry: await registry.getAddress(), verifier: await verifier.getAddress(), schemaVersion: v3.REGISTRY_V3_SCHEMA };
    batchDomain = { chainId, registry: await batchReg.getAddress(), verifier: await verifier.getAddress(), schemaVersion: v3.BATCH_V3_SCHEMA };
    buildBatch = v3.createBatchStatementBuilder({ keyRing: ring, signer: { keyId: 'op-1', wallet: operator }, adapter, expect: { circuitId: CIRCUIT, policy: POLICY } });
  });

  after(async () => {
    console.log('GAS_MEASURED_LOCAL_HARDHAT ' + JSON.stringify(gas));
    await globalThis.curve_bn128?.terminate();
  });

  it('D1-G01: contract digest == TS digest (3 vectors) and domain separator matches', async () => {
    for (const cu of [0n, 640n, 2_500n]) {
      const { auth } = await newAuth({ cuUnits: cu });
      assert.equal(await registry.hashAuthorization(tuple(auth)), auth.authorizationDigest, `cu=${cu}`);
    }
    const sep = E.TypedDataEncoder.hashDomain(v3.typedDomain(domain, v3.REGISTRY_V3_NAME));
    assert.equal(await registry.domainSeparator(), sep);
  });

  it('D1-G01: static TS vector (fixed key/opening) is accepted by the Solidity registry at the vector address', async () => {
    assert.equal(domain.registry, VECTORS.domain.registry, 'registry must be the 2nd deployment of the default account');
    assert.equal(domain.verifier, VECTORS.domain.verifier);
    const a = Object.fromEntries(VECTORS.authorizationFields.map((f) => [f.name, f.value]));
    const tupleV = { circuitId: a.circuitId, verifier: a.verifier, commitment: BigInt(a.commitment), epoch: BigInt(a.epoch), minUsage: BigInt(a.minUsage), maxUsage: BigInt(a.maxUsage), bucketPolicy: a.bucketPolicy, operationRef: a.operationRef };
    assert.equal(await registry.hashAuthorization(tupleV), VECTORS.authorizationDigest);
    // enable the vector's public test key on this local registry only
    await (await registry.setSigner(VECTORS.operatorAddress, true)).wait();
    const r = fx.receiptFixture({ circuitId: CIRCUIT, cuUnits: 640n, operationId: 'op-vector-1' });
    const opening = vec.vectorOpening(r.key);
    const auth = { circuitId: CIRCUIT, epoch: BigInt(a.epoch), bucket: { min: BigInt(a.minUsage), max: BigInt(a.maxUsage) } };
    const bundle = await adapter.prove(adapter.buildWitnessInput(opening, auth));
    assert.deepEqual(bundle.publicSignals, VECTORS.publicSignals);
    const rc = await (await registry.submitReceipt(tupleV, VECTORS.authorizationSignature, { a: bundle.proof.a, b: bundle.proof.b, c: bundle.proof.c, pubSignals: bundle.publicSignals })).wait();
    assert.equal(rc.status, 1);
    assert.equal(await registry.registeredDigest(VECTORS.operationRef), VECTORS.authorizationDigest);
    await (await registry.setSigner(VECTORS.operatorAddress, false)).wait();
  });

  it('D1-G02/D1-G06: valid authorization + real proof registers; event exposes no usage/user/tenant', async () => {
    const { auth, bundle } = await newAuth({ cuUnits: 640n });
    const sub = adapter.encodeSubmission(auth, bundle);
    const tx = await registry.connect(relayer).submitReceipt(...sub.args);
    const rc = await tx.wait();
    gas.submitReceiptV3 = rc.gasUsed.toString();
    const ev = rc.logs.map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'ReceiptRegisteredV3');
    assert.equal(ev.args.operationRef, auth.operationRef);
    assert.equal(ev.args.commitment.toString(), auth.commitment);
    assert.equal(ev.args.minUsage, 0n);
    assert.equal(ev.args.maxUsage, W - 1n);
    assert.equal(ev.args.signer, operator.address);
    assert.equal(ev.args.submitter, relayer.address);
    assert.deepEqual(ev.fragment.inputs.map((i) => i.name), ['operationRef', 'commitment', 'epoch', 'minUsage', 'maxUsage', 'digest', 'signer', 'submitter']);
    assert.equal(await registry.registeredDigest(auth.operationRef), auth.authorizationDigest);
  });

  it('D1-G02: each authorized field, proof, signature and signer is enforced', async () => {
    const { auth, bundle } = await newAuth({ cuUnits: 641n });
    const [a, sig, proof] = adapter.encodeSubmission(auth, bundle).args;
    const mutations = {
      commitment: { ...a, commitment: a.commitment + 1n },
      epoch: { ...a, epoch: a.epoch + 1n },
      window: { ...a, minUsage: W, maxUsage: 2n * W - 1n },
      operationRef: { ...a, operationRef: E.ZeroHash.replace(/0$/, '1') },
      circuitId: { ...a, circuitId: E.id('metering_v3@other') },
      bucketPolicy: { ...a, bucketPolicy: E.id('other-policy') },
      verifier: { ...a, verifier: attacker.address },
    };
    for (const [name, m] of Object.entries(mutations)) await expectRevert(registry.submitReceipt(m, sig, proof), 'UnauthorizedSigner');
    // proof bytes altered → verifier says no
    await expectRevert(registry.submitReceipt(a, sig, { ...proof, a: [proof.a[1], proof.a[0]] }), 'InvalidProof');
    // a real proof of ANOTHER commitment with this authorization
    const other = await newAuth({ cuUnits: 641n });
    await expectRevert(registry.submitReceipt(a, sig, adapter.encodeSubmission(other.auth, other.bundle).args[2]), 'PublicSignalsMismatch');
    // signature garbage / short / high-s
    await expectRevert(registry.submitReceipt(a, '0x' + '11'.repeat(65), proof), 'BadSignature');
    await expectRevert(registry.submitReceipt(a, '0x1234', proof), 'BadSignature');
    const s = E.Signature.from(sig);
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = E.concat([s.r, E.toBeHex(N - BigInt(s.s), 32), s.v === 27 ? '0x1c' : '0x1b']);
    await expectRevert(registry.submitReceipt(a, highS, proof), 'BadSignature');
    // well-formed signature by a key that is not enabled on chain
    const strangerSig = await stranger.signTypedData(v3.typedDomain(domain, v3.REGISTRY_V3_NAME), v3.AUTHORIZATION_TYPES, a);
    await expectRevert(registry.submitReceipt(a, strangerSig, proof), 'UnauthorizedSigner');
    // operator-signed (valid signature) but naming another verifier / policy than this registry's
    const signedBy = (vals) => operator.signTypedData(v3.typedDomain(domain, v3.REGISTRY_V3_NAME), v3.AUTHORIZATION_TYPES, vals);
    await expectRevert(registry.submitReceipt(mutations.verifier, await signedBy(mutations.verifier), proof), 'WrongVerifier');
    await expectRevert(registry.submitReceipt(mutations.bucketPolicy, await signedBy(mutations.bucketPolicy), proof), 'WrongBucketPolicy');
    await expectRevert(registry.submitReceipt(mutations.circuitId, await signedBy(mutations.circuitId), proof), 'WrongCircuit');
    // operator-signed misaligned window of the right width
    const mis = { ...a, minUsage: 1n, maxUsage: W };
    await expectRevert(registry.submitReceipt(mis, await signedBy(mis), proof), 'BadBucket');
    // sanity: unmodified submission still succeeds afterwards
    await (await registry.submitReceipt(a, sig, proof)).wait();
  });

  it('D1-G02: zero addresses, owner-only signer admin, revocation and rotation', async () => {
    const RegF = await ethers.getContractFactory('ReceiptRegistryV3');
    await expectRevert(RegF.deploy(E.ZeroAddress, operator.address, v3.circuitIdHash(CIRCUIT), v3.bucketPolicyId(POLICY), W), 'ZeroAddress');
    await expectRevert(RegF.deploy(await verifier.getAddress(), E.ZeroAddress, v3.circuitIdHash(CIRCUIT), v3.bucketPolicyId(POLICY), W), 'ZeroAddress');
    await expectRevert(registry.connect(attacker).setSigner(attacker.address, true), 'NotOwner');
    const { auth, bundle } = await newAuth({ cuUnits: 5n });
    const args = adapter.encodeSubmission(auth, bundle).args;
    await (await registry.setSigner(operator.address, false)).wait();
    await expectRevert(registry.submitReceipt(...args), 'UnauthorizedSigner');
    // rotation: new key enabled, old stays revoked
    const next = E.Wallet.createRandom();
    await (await registry.setSigner(next.address, true)).wait();
    const ring2 = v3.createKeyRing([{ keyId: 'op-2', address: next.address, status: 'active' }]);
    const n2 = await newAuth({ cuUnits: 6n, wallet: next, keyId: 'op-2', keyRing: ring2 });
    await (await registry.submitReceipt(...adapter.encodeSubmission(n2.auth, n2.bundle).args)).wait();
    await (await registry.setSigner(next.address, false)).wait();
    await (await registry.setSigner(operator.address, true)).wait();
    await (await registry.submitReceipt(...args)).wait();
  });

  it('D1-G02: operator-signed narrow window is refused (fixed policy width enforced on chain)', async () => {
    const { auth, bundle } = await newAuth({ cuUnits: 700n, narrow: true });
    assert.equal(auth.bucket.min, 700_000_000n);
    await expectRevert(registry.submitReceipt(...adapter.encodeSubmission(auth, bundle).args), 'BadBucket');
  });

  it('D1-G03: R16 replays fail — copied signature cannot authorize other values or another proof', async () => {
    const legit = await newAuth({ cuUnits: 640n });
    const [a, sig, proof] = adapter.encodeSubmission(legit.auth, legit.bundle).args;
    await (await registry.connect(relayer).submitReceipt(a, sig, proof)).wait();
    // attacker: fabricated values (as in L1_R16_R21_DEMO: other user/usage) with the copied signature
    const fake = await newAuth({ cuUnits: 1n });
    const [fa, , fproof] = adapter.encodeSubmission(fake.auth, fake.bundle).args;
    await expectRevert(registry.connect(attacker).submitReceipt(fa, sig, fproof), 'UnauthorizedSigner');
    // attacker: legit authorization + own proof for other values
    await expectRevert(registry.connect(attacker).submitReceipt({ ...a, operationRef: fa.operationRef }, sig, fproof), 'UnauthorizedSigner');
    // attacker: exact replay of the legit calldata
    await expectRevert(registry.connect(attacker).submitReceipt(a, sig, proof), 'AlreadyRegistered');
  });

  it('D1-G03: R21 — single-receipt signature is no batch statement; forged 1,000,000 batch refused; unregistered root not included', async () => {
    const legit = await newAuth({ cuUnits: 10n });
    const sig = legit.auth.signature.signature;
    const forged = { root: E.hexlify(E.randomBytes(32)), cardinality: 1_000_000n, memberValidation: 2, firstEpoch: 1n, lastEpoch: 2n };
    await expectRevert(batchReg.connect(attacker).registerBatch(forged, sig), 'UnauthorizedSigner');
    const strangerSig = await stranger.signTypedData(v3.typedDomain(batchDomain, v3.BATCH_V3_NAME), v3.BATCH_TYPES, forged);
    await expectRevert(batchReg.connect(attacker).registerBatch(forged, strangerSig), 'UnauthorizedSigner');
    const leaf = E.keccak256(E.toUtf8Bytes('any leaf'));
    const sibling = E.keccak256(E.toUtf8Bytes('any sibling'));
    const root = v3.nodeHash(v3.leafHash(leaf), sibling);
    assert.equal(await batchReg.verifyInclusion(root, 0, leaf, [sibling]), false);
  });

  it('D1-G04: replay, other contract, other chain → defined result, no duplicate effect; timeout retry sends nothing', async () => {
    const x = await newAuth({ cuUnits: 900n });
    const args = adapter.encodeSubmission(x.auth, x.bundle).args;
    // "timeout": transaction sent, response lost; the caller only knows the authorization
    const sent = await registry.connect(relayer).submitReceipt(...args);
    await sent.wait();
    const nonceBefore = await ethers.provider.getTransactionCount(relayer.address);
    const state = v3.classifyRegistration(await registry.registeredDigest(x.auth.operationRef), x.auth);
    assert.equal(state, 'registered_same');
    assert.equal(await ethers.provider.getTransactionCount(relayer.address), nonceBefore, 'no second transaction');
    await expectRevert(registry.submitReceipt(...args), 'AlreadyRegistered');
    // same operationRef, other content (operator bug) → conflict, never overwrite
    const y = await newAuth({ cuUnits: 901n });
    const yv = { ...v3.authorizationValues(y.auth), operationRef: x.auth.operationRef };
    const ysig = await operator.signTypedData(v3.typedDomain(domain, v3.REGISTRY_V3_NAME), v3.AUTHORIZATION_TYPES, yv);
    await expectRevert(registry.submitReceipt(yv, ysig, adapter.encodeSubmission(y.auth, y.bundle).args[2]), 'AlreadyRegistered');
    assert.equal(v3.classifyRegistration(await registry.registeredDigest(x.auth.operationRef), y.auth), 'registered_conflict');
    // same commitment under a fresh operationRef → refused
    const zv = { ...v3.authorizationValues(x.auth), operationRef: E.id('fresh-ref') };
    const zsig = await operator.signTypedData(v3.typedDomain(domain, v3.REGISTRY_V3_NAME), v3.AUTHORIZATION_TYPES, zv);
    await expectRevert(registry.submitReceipt(zv, zsig, args[2]), 'CommitmentAlreadyUsed');
    // other contract with identical parameters: signature for registry #1 does not authorize #2
    const reg2 = await (await ethers.getContractFactory('ReceiptRegistryV3')).deploy(await verifier.getAddress(), operator.address, v3.circuitIdHash(CIRCUIT), v3.bucketPolicyId(POLICY), W);
    const w = await newAuth({ cuUnits: 902n });
    await expectRevert(reg2.submitReceipt(...adapter.encodeSubmission(w.auth, w.bundle).args), 'UnauthorizedSigner');
    // other chain id: authorization built for chain 1 is not valid on this chain
    const c1 = await newAuth({ cuUnits: 903n, registryDomain: { ...domain, chainId: 1n } });
    await expectRevert(registry.submitReceipt(...adapter.encodeSubmission(c1.auth, c1.bundle).args), 'UnauthorizedSigner');
    // other schema version (e.g. a future v4 builder) → refused by the TS builder itself
    await assert.rejects(newAuth({ registryDomain: { ...domain, schemaVersion: 'otk.registry.v4' } }), /schemaVersion/);
    assert.equal(v3.classifyRegistration(await registry.registeredDigest(w.auth.operationRef), w.auth), 'not_registered');
  });

  it('D1-G05: batch validated per member (signature+proof); cardinality/root/member/context changes rejected', async () => {
    const members = [];
    for (const cu of [11n, 12n, 13n]) { const m = await newAuth({ cuUnits: cu }); members.push({ auth: m.auth, bundle: m.bundle }); }
    const st = await buildBatch({ domain: batchDomain, members });
    assert.equal(st.memberValidation, 'signature_and_proof_each');
    assert.equal(st.cardinality, 3n);
    const tupleSt = { root: st.root, cardinality: st.cardinality, memberValidation: 2, firstEpoch: st.firstEpoch, lastEpoch: st.lastEpoch };
    assert.equal(await batchReg.hashBatch(tupleSt), st.signature.payloadDigest);
    // altered statement fields → signature no longer matches
    for (const m of [{ ...tupleSt, cardinality: 1_000_000n }, { ...tupleSt, root: E.id('other') }, { ...tupleSt, memberValidation: 1 }, { ...tupleSt, lastEpoch: st.lastEpoch + 1n }]) {
      await expectRevert(batchReg.registerBatch(m, st.signature.signature), 'UnauthorizedSigner');
    }
    const rc = await (await batchReg.connect(relayer).registerBatch(tupleSt, st.signature.signature)).wait();
    gas.registerBatchV3_3members = rc.gasUsed.toString();
    await expectRevert(batchReg.registerBatch(tupleSt, st.signature.signature), 'RootAlreadyRegistered');
    const leaves = v3.batchLeaves(members);
    for (let i = 0; i < 3; i++) assert.equal(await batchReg.verifyInclusion(st.root, i, leaves[i], v3.merkleProof(leaves, i)), true, `member ${i}`);
    assert.equal(await batchReg.verifyInclusion(st.root, 3, leaves[2], v3.merkleProof(leaves, 2)), false, 'index ≥ cardinality');
    assert.equal(await batchReg.verifyInclusion(st.root, 0, leaves[1], v3.merkleProof(leaves, 0)), false, 'other member at index 0');
    const outsider = await newAuth({ cuUnits: 14n });
    assert.equal(await batchReg.verifyInclusion(st.root, 0, outsider.auth.authorizationDigest, v3.merkleProof(leaves, 0)), false, 'member of no batch');
    // declared level 0 (none) refused even when correctly signed
    const st0 = { ...tupleSt, root: E.id('level0'), memberValidation: 0 };
    await expectRevert(batchReg.registerBatch(st0, await operator.signTypedData(v3.typedDomain(batchDomain, v3.BATCH_V3_NAME), v3.BATCH_TYPES, st0)), 'BadMemberValidation');
    // builder refuses a member whose proof is for other signals, and a forged member signature
    await assert.rejects(buildBatch({ domain: batchDomain, members: [{ auth: members[0].auth, bundle: members[1].bundle }] }), /other public signals/);
    const forgedMember = { ...members[0].auth, signature: { ...members[0].auth.signature, signature: await stranger.signTypedData(v3.typedDomain(domain, v3.REGISTRY_V3_NAME), v3.AUTHORIZATION_TYPES, v3.authorizationValues(members[0].auth)) } };
    await assert.rejects(buildBatch({ domain: batchDomain, members: [{ auth: forgedMember, bundle: null }] }), /authorization rejected/);
    // without bundles the declared level is signature_each, never "proofs verified"
    const sOnly = await buildBatch({ domain: batchDomain, members: members.map((m) => ({ auth: m.auth, bundle: null })).slice(0, 2) });
    assert.equal(sOnly.memberValidation, 'signature_each');
  });

  it('D6-G02: wrong artifact combinations are rejected by the system', async () => {
    const x = await newAuth({ cuUnits: 950n });
    const args = adapter.encodeSubmission(x.auth, x.bundle).args;
    // registry deployed for another circuit id
    const regOtherCircuit = await (await ethers.getContractFactory('ReceiptRegistryV3')).deploy(await verifier.getAddress(), operator.address, v3.circuitIdHash('metering_v3@sha256:other'), v3.bucketPolicyId(POLICY), W);
    const dOther = { ...domain, registry: await regOtherCircuit.getAddress() };
    const y = await newAuth({ cuUnits: 951n, registryDomain: dOther });
    await expectRevert(regOtherCircuit.submitReceipt(...adapter.encodeSubmission(y.auth, y.bundle).args), 'WrongCircuit');
    // new proof checked by the historical v2 MPC verifier (same uint[4] interface): refused
    const v2 = await (await ethers.getContractFactory('MeteringVerifierV2MPC')).deploy();
    const regOldVerifier = await (await ethers.getContractFactory('ReceiptRegistryV3')).deploy(await v2.getAddress(), operator.address, v3.circuitIdHash(CIRCUIT), v3.bucketPolicyId(POLICY), W);
    const dOld = { ...domain, registry: await regOldVerifier.getAddress(), verifier: await v2.getAddress() };
    const z = await newAuth({ cuUnits: 952n, registryDomain: dOld });
    await expectRevert(regOldVerifier.submitReceipt(...adapter.encodeSubmission(z.auth, z.bundle).args), 'InvalidProof');
    // authorization naming the v3 verifier sent to a registry wired to the old verifier
    await expectRevert(regOldVerifier.submitReceipt(...args), 'UnauthorizedSigner');
    await (await registry.submitReceipt(...args)).wait();
  });

  it('D2-G03 (on chain): calldata/event carry no exact usage; old N13 equality test with naive blinding guesses finds nothing (sanity check, not a privacy proof)', async () => {
    const x = await newAuth({ cuUnits: 640n });
    const tx = await registry.connect(relayer).submitReceipt(...adapter.encodeSubmission(x.auth, x.bundle).args);
    await tx.wait();
    const pubTx = await ethers.provider.getTransaction(tx.hash);
    const decoded = registry.interface.parseTransaction({ data: pubTx.data });
    const pub = decoded.args[0];
    const fields = Object.fromEntries(['circuitId', 'verifier', 'commitment', 'epoch', 'minUsage', 'maxUsage', 'bucketPolicy', 'operationRef'].map((k) => [k, pub[k].toString()]));
    for (const v of Object.values(fields)) assert.ok(v !== '640' && v !== '640000000', 'calldata exposes exact usage');
    const { poseidonHash } = v3;
    let hits = 0;
    // even granting the attacker the userRef (42) and the legacy-style nonce guesses
    for (let cu = 0n; cu <= 640n; cu++) for (const g of [0n, 1n, BigInt(fields.epoch)]) {
      if ((await poseidonHash([v3.TAG_V3, cu * 1_000_000n, g, 42n, BigInt(fields.epoch)])) === BigInt(fields.commitment)) hits++;
    }
    assert.equal(hits, 0);
  });
});
