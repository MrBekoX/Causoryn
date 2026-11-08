import { ContractDiscoveryError } from "./errors.js";
import type { ServiceAnchor } from "./types.js";

/**
 * Servis ankrajı tarayıcı — SADELEŞTİRİLMİŞ satır tarayıcısı (TŞ §11
 * produces/consumes eşleştirmesinin servis tarafı; sprint-5 D1).
 *
 * Belgeli SINIRLI dilim:
 * - endpoint: `router|app.<method>("route"` kalıbı (method: get/post/put/
 *   patch/delete/head/options).
 * - producer/consumer: `publish("topic"` / `subscribe("topic"` kalıpları.
 * - table: `INSERT INTO <tablo>` (öncelikli) ya da `FROM <tablo>`.
 * - `//` ve `--` satır yorumları çıkarılır ("://" korumalı); blok yorumlar
 *   bu dilimde temizlenmez (belgeli kısıt: fixture'lar yorum kalıbı taşımaz).
 * - Satır başına tür başına EN FAZLA BİR ankraj (ilk eşleşme) — determinizm.
 * - Desenler basit literal kalıplardır: iç içe niceleyici YOK, geri izleme
 *   riski yok (ReDoS sınırlı desenler kırmızı çizgisi).
 */

const ENDPOINT_PATTERN =
  /(?:^|[^\w.])(?:router|app)\.(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`]+)\2/u;
const PUBLISH_PATTERN = /\bpublish\s*\(\s*(['"`])([^'"`]+)\1/u;
const SUBSCRIBE_PATTERN = /\bsubscribe\s*\(\s*(['"`])([^'"`]+)\1/u;
const INSERT_INTO_PATTERN = /\bINSERT\s+INTO\s+([A-Za-z_][\w$]*)/iu;
const FROM_PATTERN = /\bFROM\s+([A-Za-z_][\w$]*)/iu;

/** Satır yorumunu çıkarır; "://" (URL şemaları) korunur. */
function stripLineComment(line: string): string {
  let searchFrom = 0;
  for (;;) {
    const index = line.indexOf("//", searchFrom);
    if (index === -1) return line;
    if (index > 0 && line[index - 1] === ":") {
      searchFrom = index + 2;
      continue;
    }
    return line.slice(0, index);
  }
}

function stripSqlComment(line: string): string {
  const index = line.indexOf("--");
  return index === -1 ? line : line.slice(0, index);
}

export function scanServiceAnchors(
  relativePath: string,
  text: string,
  symbol: string,
): ServiceAnchor[] {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    throw new ContractDiscoveryError("contracts/invalid-input", "relativePath boş olamaz");
  }
  if (typeof text !== "string") {
    throw new ContractDiscoveryError("contracts/invalid-input", "text string olmalı");
  }
  if (typeof symbol !== "string" || symbol.trim().length === 0) {
    throw new ContractDiscoveryError("contracts/invalid-input", "symbol boş olamaz");
  }

  const anchors: ServiceAnchor[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined) break; // noUncheckedIndexedAccess güvencesi
    const line = stripSqlComment(stripLineComment(raw));
    if (line.trim().length === 0) continue;
    const lineNo = i + 1;

    const endpoint = line.match(ENDPOINT_PATTERN);
    if (endpoint !== null) {
      anchors.push({
        anchorKind: "endpoint",
        symbol,
        method: (endpoint[1] ?? "").toUpperCase(),
        route: endpoint[3] ?? "",
        evidence: { relativePath, startLine: lineNo, endLine: lineNo },
      });
    }

    const producer = line.match(PUBLISH_PATTERN);
    if (producer !== null) {
      anchors.push({
        anchorKind: "producer",
        symbol,
        topic: producer[2] ?? "",
        evidence: { relativePath, startLine: lineNo, endLine: lineNo },
      });
    }

    const consumer = line.match(SUBSCRIBE_PATTERN);
    if (consumer !== null) {
      anchors.push({
        anchorKind: "consumer",
        symbol,
        topic: consumer[2] ?? "",
        evidence: { relativePath, startLine: lineNo, endLine: lineNo },
      });
    }

    const insertInto = line.match(INSERT_INTO_PATTERN);
    const tableMatch = insertInto ?? line.match(FROM_PATTERN);
    if (tableMatch !== null) {
      anchors.push({
        anchorKind: "table",
        symbol,
        table: tableMatch[1] ?? "",
        evidence: { relativePath, startLine: lineNo, endLine: lineNo },
      });
    }
  }

  return anchors;
}
