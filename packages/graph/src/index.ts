/**
 * @causoryn/graph — Graph depo katmanı (Faz A dilimi, sprint-1 görev 5).
 *
 * GraphRepository sözleşmesi (TŞ v2.1 §8/§9, ADR-004/005): building →
 * ready/partial atomik snapshot yayımlama, stale bayrağı, dangling/ID
 * türetim denetimleri. Bellek içi gerçekleme referanstır; SQLite
 * gerçekleme `packages/storage-sqlite` altındadır. Snapshot okuma
 * sorguları/traversal bu paketin sonraki dilimlerinde gelir.
 */
export { GraphRepositoryError } from "./errors.js";
export { deriveBuildId } from "./build-id.js";
export type { BuildIdInput } from "./build-id.js";
export { finalizeSnapshotGraph } from "./finalize.js";
export type { BuildContent, SnapshotMetaInput } from "./finalize.js";
export {
  nodeIdentityRelativePath,
  requireNonEmptyField,
  requireTimestamp,
  validateEdgeIdentity,
  validateEdgeShape,
  validateEvidence,
  validateNode,
} from "./validation.js";
export { InMemoryGraphRepository } from "./memory-repository.js";
export type {
  FileRecord,
  GraphRepository,
  PublishableState,
  SnapshotBuildInfo,
  SnapshotBuildInput,
  SnapshotRead,
  SymbolIndexEntry,
  SymbolSearchHit,
  SymbolSearchStore,
  WorkspaceRecord,
} from "./repository.js";
