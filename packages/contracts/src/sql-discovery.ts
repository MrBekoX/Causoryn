import { Buffer } from "node:buffer";

import { nodeId } from "@causoryn/domain";

import { ContractDiscoveryError } from "./errors.js";
import { assertSpecSize } from "./parse-safety.js";
import { compareStrings } from "./order.js";
import type {
  ContractCandidate,
  ContractDiagnostic,
  ContractProperty,
  DiscoveryOutput,
} from "./types.js";

/**
 * SQL migration keşfi — TŞ §11: "SQL migration/schema" (read-only; TŞ §11:
 * "Kullanıcının workspace'ini değiştirmek için migration çalıştırılmaz").
 *
 * SADELEŞTİRİLMİŞ satır/statement parser'ı — belgeli SINIRLI dilim:
 * - `--` yorumları çıkarılır; blok yorum bu dilimde tanınmaz.
 * - Statement'lar `;` ile bölünür; CREATE/ALTER/DROP kalıpları satır
 *   normalizasyonu + paren-duyarlı bölme ile tanınır.
 * - Saklı yordam, trigger, görünüm, CTE, LIKE ile kopyalama tanınmaz;
 *   tanınmayan statement sessizce yok sayılır (uydurma güven üretmemek
 *   için diagnostic da düşülmez).
 * - Kolon tipi beyaz liste DEĞİLDİR: isim + ham tip metni taşınır
 *   (VARCHAR(3), DECIMAL(10,2) içindeki virgül paren-duyarlı bölmeyle
 *   korunur). `required` yalnızca `NOT NULL` görülürse true.
 * - Her dosya bağımsız parse edilir (dosyalar arası state yok; v1↔v2 farkı
 *   D3 diff'inin işidir).
 * - certainty disiplini: full yalnızca CREATE TABLE gövdesi GÖRÜLDÜĞÜNDE ve
 *   o tabloya DROP/RENAME değişimi düşmediğinde; yalnızca ALTER görülen
 *   dosyada tablo yapısı kısmen bilindiği için partial. DROP COLUMN /
 *   RENAME COLUMN / RENAME TO → diagnostic; DROP TABLE → yalnızca
 *   diagnostic (sözleşme değil değişim olayı; keşif adayı ÜRETMEZ).
 */

interface SqlStatement {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
}

interface TableBuild {
  readonly name: string;
  readonly properties: readonly ContractProperty[];
  readonly firstEvidenceLine: number;
  readonly lastEvidenceLine: number;
  /** CREATE TABLE gövdesi bu dosyada görüldü mü. */
  readonly sawCreate: boolean;
  /** Tabloya düşen DROP/RENAME değişim sayısı (certainty düşürür). */
  readonly degradations: number;
}

/** `--` yorumunu satırdan çıkarır. */
function stripSqlComment(line: string): string {
  const index = line.indexOf("--");
  return index === -1 ? line : line.slice(0, index);
}

function splitStatements(text: string): SqlStatement[] {
  const lines = text.split(/\r?\n/);
  const statements: SqlStatement[] = [];
  let buffer: string[] = [];
  let startLine = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    // noUncheckedIndexedAccess güvencesi
    if (raw === undefined) break;
    const line = stripSqlComment(raw);
    const hasContent = line.trim().length > 0;
    if (buffer.length === 0) {
      if (!hasContent) continue;
      startLine = i + 1;
    }
    buffer.push(line);
    if (line.includes(";")) {
      // Sondaki ';' statement ayıracıdır; kolon tipine sızmasın
      // ("VARCHAR(256);" gibi). Belgeli sınırlama: ';' her zaman ayırıcıdır.
      const statementText = buffer
        .join("\n")
        .replace(/;/gu, " ");
      statements.push({ text: statementText, startLine, endLine: i + 1 });
      buffer = [];
    }
  }
  if (buffer.length > 0) {
    statements.push({ text: buffer.join("\n"), startLine, endLine: lines.length });
  }
  return statements;
}

/** Paren-duyarlı üst düzey virgülle bölme: VARCHAR(3)/DECIMAL(10,2) korunur. */
function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of body) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Tablo düzeyi constraint satırları kolon sayılmaz. */
const TABLE_CONSTRAINT_KEYWORDS = /^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT|KEY|INDEX)\b/i;

/** Kolon tanımında tip listesini kapatan anahtar kelimeler. */
const COLUMN_CONSTRAINT_KEYWORDS = new Set([
  "not",
  "null",
  "default",
  "primary",
  "unique",
  "references",
  "check",
  "constraint",
  "auto_increment",
  "collate",
  "comment",
  "generated",
  "as",
  "on",
]);

interface ColumnParse {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

function parseColumn(part: string): ColumnParse | undefined {
  if (TABLE_CONSTRAINT_KEYWORDS.test(part)) return undefined;
  const nameMatch = part.match(/^\s*["`[]?([A-Za-z_][\w$]*)["`\]]?\s+/u);
  if (nameMatch === null) return undefined;
  const name = nameMatch[1];
  if (name === undefined) return undefined;
  const rest = part.slice(nameMatch[0].length);
  if (rest.length === 0) return undefined;

  const required = /\bNOT\s+NULL\b/iu.test(rest);
  let depth = 0;
  const typeTokens: string[] = [];
  for (const rawToken of rest.split(/\s+/u)) {
    if (depth === 0 && COLUMN_CONSTRAINT_KEYWORDS.has(rawToken.toLowerCase())) break;
    typeTokens.push(rawToken);
    for (const ch of rawToken) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
    }
    if (depth < 0) break;
  }
  const type = typeTokens.join(" ").trim();
  if (type.length === 0) return undefined;
  return { name, type, required };
}

function parseCreateTable(statement: SqlStatement): { name: string; columns: ColumnParse[] } | undefined {
  const flattened = statement.text.replace(/\s+/gu, " ");
  const match = flattened.match(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_][\w$]*)["`\]]?\s*\(/i,
  );
  if (match === null) return undefined;
  const name = match[1];
  if (name === undefined) return undefined;
  const openIndex = flattened.indexOf("(", (match.index ?? 0));
  if (openIndex === -1) return undefined;

  let depth = 0;
  let closeIndex = -1;
  for (let i = openIndex; i < flattened.length; i += 1) {
    const ch = flattened[i];
    if (ch === undefined) break;
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        closeIndex = i;
        break;
      }
    }
  }
  if (closeIndex === -1) return undefined;
  const body = flattened.slice(openIndex + 1, closeIndex);
  const columns: ColumnParse[] = [];
  for (const part of splitTopLevelCommas(body)) {
    const column = parseColumn(part);
    if (column !== undefined) columns.push(column);
  }
  return { name, columns };
}

function parseAlterActions(action: string): {
  readonly addColumn?: ColumnParse;
  readonly dropColumn?: string;
  readonly renameColumn?: { readonly from: string; readonly to: string };
  readonly renameTable?: string;
} {
  if (!/[\r\n\u2028\u2029]/.test(action)) {
    const addMatch = action.match(/^ADD\s+(?:COLUMN\s+)?["`[]?/i);
    if (addMatch !== null) {
      const rest = action.slice(addMatch[0].length);
      if (rest.length > 0) {
        const column = parseColumn(rest);
        if (column !== undefined) return { addColumn: column };
      }
    }
  }
  const dropMatch = action.match(/^DROP\s+(?:COLUMN\s+)?["`[]?([A-Za-z_][\w$]*)["`\]]?\s*$/i);
  if (dropMatch !== null) {
    return { dropColumn: dropMatch[1] ?? "" };
  }
  const renameColumnMatch = action.match(
    /^RENAME\s+(?:COLUMN\s+)?["`[]?([A-Za-z_][\w$]*)["`\]]?\s+TO\s+["`[]?([A-Za-z_][\w$]*)["`\]]?\s*$/i,
  );
  if (renameColumnMatch !== null) {
    return { renameColumn: { from: renameColumnMatch[1] ?? "", to: renameColumnMatch[2] ?? "" } };
  }
  const renameTableMatch = action.match(/^RENAME\s+TO\s+["`[]?([A-Za-z_][\w$]*)["`\]]?\s*$/i);
  if (renameTableMatch !== null) {
    return { renameTable: renameTableMatch[1] ?? "" };
  }
  return {};
}

export function discoverSqlContracts(
  workspaceId: string,
  relativePath: string,
  text: string,
): DiscoveryOutput {
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    throw new ContractDiscoveryError("contracts/invalid-input", "workspaceId boş olamaz");
  }
  if (typeof text !== "string") {
    throw new ContractDiscoveryError("contracts/invalid-input", "text string olmalı");
  }
  // Boyut kotası yaml/json yollarıyla simetriktir (kırmızı çizgi 6; TŞ §19):
  // saf çekirdek sınırsız metin kabul etmez (takım denetimi bulgusu 1).
  assertSpecSize(Buffer.byteLength(text, "utf8"));

  const builds = new Map<string, TableBuild>();
  const diagnostics: ContractDiagnostic[] = [];

  const touch = (table: string, statement: SqlStatement): void => {
    const existing = builds.get(table);
    if (existing === undefined) {
      builds.set(table, {
        name: table,
        properties: [],
        firstEvidenceLine: statement.startLine,
        lastEvidenceLine: statement.endLine,
        sawCreate: false,
        degradations: 0,
      });
    }
  };

  for (const statement of splitStatements(text)) {
    const create = parseCreateTable(statement);
    if (create !== undefined) {
      const existing = builds.get(create.name);
      builds.set(create.name, {
        name: create.name,
        properties:
          existing === undefined
            ? [...create.columns]
            : [...existing.properties, ...create.columns],
        firstEvidenceLine: existing?.firstEvidenceLine ?? statement.startLine,
        lastEvidenceLine: statement.endLine,
        sawCreate: true,
        degradations: existing?.degradations ?? 0,
      });
      continue;
    }
    if (/^\s*ALTER\s+TABLE\b/i.test(statement.text)) {
      const flat = statement.text.replace(/\s+/gu, " ");
      const match = flat.match(
        /^\s*ALTER\s+TABLE\s+(?:ONLY\s+)?["`[]?([A-Za-z_][\w$]*)["`\]]?\s+/i,
      );
      const table = match?.[1];
      if (match === null || table === undefined) continue;
      const rest = flat.slice(match[0].length);
      if (rest.length === 0) continue;
      const actions = parseAlterActions(rest);
      if (actions.addColumn !== undefined) {
        const existing = builds.get(table) ?? {
          name: table,
          properties: [],
          firstEvidenceLine: statement.startLine,
          lastEvidenceLine: statement.startLine,
          sawCreate: false,
          degradations: 0,
        };
        builds.set(table, {
          ...existing,
          properties: [
            ...existing.properties,
            {
              name: actions.addColumn.name,
              type: actions.addColumn.type,
              required: actions.addColumn.required,
            },
          ],
          lastEvidenceLine: statement.endLine,
        });
        continue;
      }
      if (actions.dropColumn !== undefined) {
        touch(table, statement);
        diagnostics.push({
          relativePath,
          code: "contracts/sql-drop-column",
          message:
            "ALTER TABLE " + table + " DROP COLUMN " + actions.dropColumn +
            " — kolon kaldırma; tüketici etkisi adayı (TŞ §11)",
          line: statement.startLine,
        });
        const existing = builds.get(table);
        if (existing !== undefined) {
          builds.set(table, { ...existing, degradations: existing.degradations + 1 });
        }
        continue;
      }
      if (actions.renameColumn !== undefined) {
        touch(table, statement);
        diagnostics.push({
          relativePath,
          code: "contracts/sql-rename-column",
          message:
            "ALTER TABLE " + table + " RENAME COLUMN " + actions.renameColumn.from +
            " TO " + actions.renameColumn.to,
          line: statement.startLine,
        });
        const existing = builds.get(table);
        if (existing !== undefined) {
          builds.set(table, { ...existing, degradations: existing.degradations + 1 });
        }
        continue;
      }
      if (actions.renameTable !== undefined) {
        touch(table, statement);
        diagnostics.push({
          relativePath,
          code: "contracts/sql-rename-table",
          message: "ALTER TABLE " + table + " RENAME TO " + actions.renameTable,
          line: statement.startLine,
        });
        const existing = builds.get(table);
        if (existing !== undefined) {
          builds.set(table, { ...existing, degradations: existing.degradations + 1 });
        }
      }
      continue;
    }
    const dropTableMatch = statement.text
      .replace(/\s+/gu, " ")
      .match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`[]?([A-Za-z_][\w$]*)["`\]]?/i);
    if (dropTableMatch !== null) {
      const table = dropTableMatch[1] ?? "";
      diagnostics.push({
        relativePath,
        code: "contracts/sql-drop-table",
        message:
          "DROP TABLE " + table +
          " — tablo kaldırma; sözleşme değil değişim olayı (keşif adayı üretmez)",
        line: statement.startLine,
      });
    }
  }

  const contracts: ContractCandidate[] = [];
  for (const build of builds.values()) {
    contracts.push({
      contractId: nodeId({
        workspaceId,
        kind: "SchemaContract",
        qualifiedName: "table:" + build.name,
        relativePath,
      }),
      sourceKind: "sql",
      nodeKind: "SchemaContract",
      name: build.name,
      qualifiedName: "table:" + build.name,
      responseSchemaIds: [],
      properties: build.properties,
      requiredPropertyNames: build.properties
        .filter((property) => property.required)
        .map((property) => property.name),
      resolvedRefs: [],
      certainty: build.sawCreate && build.degradations === 0 ? "full" : "partial",
      evidence: {
        relativePath,
        startLine: build.firstEvidenceLine,
        endLine: Math.max(build.lastEvidenceLine, build.firstEvidenceLine),
      },
      diagnostics: [],
    });
  }

  contracts.sort(
    (a, b) =>
      compareStrings(a.qualifiedName, b.qualifiedName) ||
      a.evidence.startLine - b.evidence.startLine,
  );
  diagnostics.sort((a, b) => a.line - b.line);
  return { contracts, diagnostics };
}
