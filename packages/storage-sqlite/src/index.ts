/**
 * @causoryn/storage-sqlite — SQLite + FTS5 graph store (Faz A dilimi,
 * sprint-1 görev 5).
 *
 * GraphRepository sözleşmesinin kalıcı gerçeklemesi (TŞ v2.1 §9):
 * workspaces/files/snapshots/nodes/edges/evidence (+ edge_evidence)
 * tabloları, WAL, atomik snapshot yayımlama (building → ready/partial;
 * eski yayın stale=true ile sorgulanabilir kalır) ve symbol_fts temel
 * ekleme/arama. Tüm girdiler hazırlanmış ifadelerle parametrelenir.
 */
export { GraphRepositoryError } from "@causoryn/graph";
export { applySchema, SCHEMA_VERSION } from "./schema.js";
export { SqliteGraphRepository } from "./sqlite-repository.js";
