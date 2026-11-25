/**
 * H2-EVAL / R13 — pontos de integração da frente de cache/diálogos/corpus (scripts/h2eval/INTERFACES.md §9, dono E2E-01).
 * `createContentStore(dir)` e `planArm(...)` são os nomes pedidos pela integradora; o resto é a API de apoio.
 *
 * English summary: barrel module of the H2 evaluation's cache, dialog and corpus front. It only re-exports: the content
 * store (`./contentStore`), the cache-arm planner (`./planner`, `planArm` is an alias of `planCacheArm`), the usage
 * classifier (`./classify`), the cost interval (`./costInterval`), the dialog builder (`./dialogs`) and the corpus
 * builders and seed guards from `../corpus/`. It has no logic and no side effects of its own.
 *
 * @module scripts/h2eval/cache/index
 */
export { createContentStore, contentOfS1, contentHash, ContentStoreError } from './contentStore.js';
export type { ContentStore, ContentStoreLike, ResolvedContentLike, StorableContent } from './contentStore.js';
export { planCacheArm as planArm, planCacheArm, wilsonLower, dialogsFor, R07_TABLE, Z80_TWO_SIDED, Z80_ONE_SIDED } from './planner.js';
export type { CachePlan, PilotObservation, PlanOptions } from './planner.js';
export { classifyCache, diagnose, resolveArm, summarizeDialog } from './classify.js';
export type { CacheObservation, Observed, Provider, PlannedArm, ArmResolution, Num } from './classify.js';
export { costInterval, costFromObservation, inInterval, picoPerToken, picoToUsd, R08_PRICES, PriceError } from './costInterval.js';
export type { CostInterval, IntervalInput, ModelPrices } from './costInterval.js';
export { buildDialogs, contentOf, controlOf, makeDialog, renderCall, renderDialog, nonceOf, auditNonceTokens, checkTtl, MIN_PREFIX_TOKENS, TTL_ASSUMED, DEFAULT_PREFIX_CHARS } from './dialogs.js';
export type { Arm, Dialog, NeutralContent, RenderedCall, RenderOptions, CallParams, NonceAudit, TtlPlan } from './dialogs.js';
export { buildCorpus } from '../corpus/manifest.js';
export { buildS1, S1_CORPUS_VERSION } from '../corpus/s1Corpus.js';
export { s1PlanFor, summarizeDesign, DEFAULT_DESIGNS } from '../corpus/s1Plan.js';
export { assertFreshSeed, DEFAULT_SEED, FORBIDDEN_SEEDS, SeedRejectedError } from '../corpus/seedGuard.js';
export { verifySeedUnused, DEFAULT_SCAN_REFS } from '../corpus/seedVerify.js';
export { collisionReport } from '../corpus/collision.js';
