/**
 * @deprecated D1-G07 (run 20260930-1625): renamed to OperatorRecountStrategy. The old name
 * suggested a provider signature that does not exist; this module only re-exports the new names
 * so existing imports keep working (explicit alias, specification A/ESPEC_NOMES_D1G07.md).
 *
 * @module src/oracle/attestation/ProviderSignedStrategy
 */
export {
  OperatorRecountStrategy as ProviderSignedStrategy,
  operatorRecountStrategy as providerSignedStrategy,
} from './OperatorRecountStrategy.js';
