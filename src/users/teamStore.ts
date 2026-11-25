/**
 * TEAM-07 — teamStore singleton
 * Returns the active ITeamStore instance.
 * Defaults to MemoryTeamStore; swap for PgTeamStore when OTK_DB_URL is set.
 *
 * @module users/teamStore
 * @since W8-C TEAM-07
 */

import type { ITeamStore } from './TeamModel.js';
import { MemoryTeamStore } from './TeamModel.js';

let _store: ITeamStore | undefined;

/**
 * Returns the process-wide team store, creating an in-memory one on first use.
 *
 * @returns The shared store.
 */
export function getTeamStore(): ITeamStore {
  if (!_store) {
    _store = new MemoryTeamStore();
  }
  return _store;
}

/**
 * Override the singleton — used in tests or when PgTeamStore is wired.
 *
 * @param store - Backend to use from now on.
 */
export function setTeamStore(store: ITeamStore): void {
  _store = store;
}
