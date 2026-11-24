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
 * protobuf keşfi — TŞ §11: "manifest/protobuf/JSON Schema".
 *
 * SADELEŞTİRİLMİŞ satır parser'ı — belgeli SINIRLI dilim (proto3):
 * - `syntax = "proto3";` satırı aranır; yoksa contracts/protobuf-no-syntax
 *   diagnostic'ı + tüm adaylar partial (proto2 sessizce tanınmaz).
 * - message/service/enum/oneof blokları `{`/`}` dengesiyle takip edilir;
 *   string literallerin içindeki süslü parantezler sayıma girmez.
 * - message alan kalıpları: `tip alan = N;`, `repeated tip alan = N;`,
 *   `map<K, V> alan = N;` → map TANINIR ama sınırlı dilim ötesi kabul
 *   edilir: contracts/protobuf-unknown-field (dosya düzeyi) + "serializer
 *   unknown" aday notu + partial (TŞ §11: server yalnızca statik delili
 *   ifade eder, unknown üretebilir).
 * - service içindeki `rpc M (Req) returns (Res);` → ApiContract adayı;
 *   `stream` → "serializer unknown" aday notu + partial.
 * - option/reserved gibi tanınmayan gövde satırları sessizce yok sayılır.
 * - Dengesiz blok → contracts/protobuf-unbalanced-block; tüm adaylar partial
 *   finalize edilir (dürüst kısmi tanıma; uydurma tamamlama yok).
 * - Tek satırda `} message X {` birleşik açılış/kapanış bu dilimde
 *   tanınmaz (belgeli kısıt; dengesizlik partial ile işaretlenir).
 */

function stripProtoComment(line: string): string {
  const index = line.indexOf("//");
  return index === -1 ? line : line.slice(0, index);
}

/** String literalleri siler (süslü parantez sayımı ve kalıp eşleşmesi için). */
function stripStringLiterals(line: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (const ch of line) {
    if (inString) {
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function countBraces(line: string): { readonly open: number; readonly close: number } {
  let open = 0;
  let close = 0;
  for (const ch of line) {
    if (ch === "{") open += 1;
    else if (ch === "}") close += 1;
  }
  return { open, close };
}

interface BlockFrame {
  readonly kind: "message" | "service" | "other";
  readonly name: string;
  readonly startLine: number;
}

interface FieldRecord {
  readonly name: string;
  readonly type: string;
  readonly unknownKind: boolean;
}

interface RpcRecord {
  readonly service: string;
  readonly name: string;
  readonly requestType: string;
  readonly responseType: string;
  readonly line: number;
  readonly streamUsed: boolean;
}

function qualifyName(name: string, packageName: string): string {
  return packageName.length > 0 ? packageName + "." + name : name;
}

function qualifyType(type: string, packageName: string): string {
  if (packageName.length === 0 || type.includes(".")) return type;
  return packageName + "." + type;
}

export function discoverProtobufContracts(
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

  const diagnostics: ContractDiagnostic[] = [];
  const lines = text.split(/\r?\n/);
  if (text.trim().length === 0) {
    return { contracts: [], diagnostics };
  }

  const hasSyntax = lines.some((line) =>
    /^\s*syntax\s*=\s*"proto3"\s*;\s*$/u.test(stripProtoComment(line)),
  );
  if (!hasSyntax) {
    diagnostics.push({
      relativePath,
      code: "contracts/protobuf-no-syntax",
      message: 'syntax = "proto3"; satırı bulunamadı; tüm adaylar partial işaretlenir',
      line: 1,
    });
  }

  let packageName = "";
  let depth = 0;
  let sawUnbalanced = false;
  const stack: BlockFrame[] = [];
  const messageFields = new Map<string, FieldRecord[]>();
  const messageRanges = new Map<string, { readonly startLine: number; endLine: number }>();
  const messageUnknown = new Map<string, boolean>();
  const rpcs: RpcRecord[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const raw = lines[i];
    if (raw === undefined) break; // noUncheckedIndexedAccess güvencesi
    const trimmedLine = stripStringLiterals(stripProtoComment(raw)).trim();
    if (trimmedLine.length === 0) continue;

    const packageMatch = trimmedLine.match(/^package\s+([A-Za-z_][\w.]*)\s*;$/u);
    if (packageMatch !== null) {
      packageName = packageMatch[1] ?? packageName;
      continue;
    }

    const blockMatch = trimmedLine.match(/^(message|service|enum|oneof)\s+([A-Za-z_]\w*)\s*\{.*$/u);
    if (blockMatch !== null) {
      const kindRaw = blockMatch[1] ?? "";
      const name = blockMatch[2] ?? "";
      const kind: BlockFrame["kind"] =
        kindRaw === "message" || kindRaw === "service" ? kindRaw : "other";
      const delta = countBraces(trimmedLine);
      depth += delta.open - delta.close;
      stack.push({ kind, name, startLine: lineNumber });
      if (kind === "message") {
        const qualified = qualifyName(name, packageName);
        if (!messageFields.has(qualified)) {
          messageFields.set(qualified, []);
          messageRanges.set(qualified, { startLine: lineNumber, endLine: lineNumber });
        }
      }
      continue;
    }

    const delta = countBraces(trimmedLine);
    if (delta.open === 0 && delta.close === 0) {
      const innermost = stack[stack.length - 1];
      if (innermost === undefined) continue;

      if (innermost.kind === "service") {
        const rpcMatch = trimmedLine.match(
          /^rpc\s+([A-Za-z_]\w*)\s*\(\s*(stream\s+)?([A-Za-z_][\w.]*)\s*\)\s*returns\s*\(\s*(stream\s+)?([A-Za-z_][\w.]*)\s*\)\s*;$/u,
        );
        if (rpcMatch !== null) {
          const streamUsed = rpcMatch[2] !== undefined || rpcMatch[4] !== undefined;
          rpcs.push({
            service: innermost.name,
            name: rpcMatch[1] ?? "",
            requestType: qualifyType(rpcMatch[3] ?? "", packageName),
            responseType: qualifyType(rpcMatch[5] ?? "", packageName),
            line: lineNumber,
            streamUsed,
          });
        }
        continue;
      }

      if (innermost.kind === "message") {
        const qualified = qualifyName(innermost.name, packageName);
        if (!messageFields.has(qualified)) {
          messageFields.set(qualified, []);
        }

        if (!trimmedLine.endsWith(";") || /[\r\n\u2028\u2029]/.test(trimmedLine)) {
          continue;
        }

        const mapMatch = trimmedLine.match(
          /^map\s*<\s*([A-Za-z_][\w.]*)\s*,\s*([A-Za-z_][\w.]*)\s*>\s+([A-Za-z_]\w*)\s*=\s*\d+/u,
        );
        if (mapMatch !== null) {
          const key = mapMatch[1] ?? "";
          const value = mapMatch[2] ?? "";
          const fieldName = mapMatch[3] ?? "";
          const fields = messageFields.get(qualified);
          if (fields !== undefined) {
            fields.push({ name: fieldName, type: "map<" + key + "," + value + ">", unknownKind: true });
          }
          messageUnknown.set(qualified, true);
          diagnostics.push({
            relativePath,
            code: "contracts/protobuf-unknown-field",
            message:
              "map<" + key + "," + value + "> alan türü (" + fieldName +
              ") sınırlı parser diliminin ötesinde — serializer unknown",
            line: lineNumber,
          });
          continue;
        }

        const fieldMatch = trimmedLine.match(
          /^(repeated\s+)?([A-Za-z_][\w.]*)\s+([A-Za-z_]\w*)\s*=\s*\d+/u,
        );
        if (fieldMatch !== null) {
          const repeated = fieldMatch[1] !== undefined;
          const type = fieldMatch[2] ?? "";
          const fieldName = fieldMatch[3] ?? "";
          const fields = messageFields.get(qualified);
          if (fields !== undefined) {
            fields.push({
              name: fieldName,
              type: repeated ? "repeated " + type : type,
              unknownKind: false,
            });
          }
        }
      }
      continue;
    }

    // Blok açılış/kapanış içeren satır
    depth += delta.open - delta.close;
    if (delta.close > 0) {
      for (let c = 0; c < delta.close; c += 1) {
        const frame = stack.pop();
        if (frame === undefined) {
          sawUnbalanced = true;
          continue;
        }
        if (frame.kind === "message") {
          const qualified = qualifyName(frame.name, packageName);
          const range = messageRanges.get(qualified);
          if (range !== undefined) {
            messageRanges.set(qualified, { startLine: range.startLine, endLine: lineNumber });
          }
        }
      }
    }
  }

  const unbalanced = depth !== 0 || stack.length > 0 || sawUnbalanced;
  if (unbalanced) {
    diagnostics.push({
      relativePath,
      code: "contracts/protobuf-unbalanced-block",
      message: "message/service bloğu kapanmadı; açık bloklar partial aday olarak finalize edildi",
      line: lines.length,
    });
    for (const frame of stack) {
      if (frame.kind === "message") {
        const qualified = qualifyName(frame.name, packageName);
        const range = messageRanges.get(qualified);
        if (range !== undefined) {
          messageRanges.set(qualified, { startLine: range.startLine, endLine: lines.length });
        }
      }
    }
  }

  const filePartial = !hasSyntax || unbalanced;
  const contracts: ContractCandidate[] = [];

  for (const [qualified, fields] of messageFields) {
    const range = messageRanges.get(qualified);
    const hasUnknown = messageUnknown.get(qualified) ?? false;
    const properties: ContractProperty[] = fields.map((field) => ({
      name: field.name,
      type: field.type,
      required: false, // proto3 alanları varsayılan olarak opsiyonel (belgeli)
    }));
    const candidateDiagnostics: string[] = [];
    if (hasUnknown) {
      const unknownField = fields.find((field) => field.unknownKind);
      candidateDiagnostics.push(
        "protobuf: " +
          (unknownField?.type ?? "bilinmeyen alan türü") +
          " alan türü sınırlı parser diliminin ötesinde — serializer unknown",
      );
    }
    contracts.push({
      contractId: nodeId({
        workspaceId,
        kind: "SchemaContract",
        qualifiedName: qualified,
        relativePath,
      }),
      sourceKind: "protobuf",
      nodeKind: "SchemaContract",
      name: qualified,
      qualifiedName: qualified,
      responseSchemaIds: [],
      properties,
      requiredPropertyNames: [],
      resolvedRefs: [],
      certainty: filePartial || hasUnknown ? "partial" : "full",
      evidence: {
        relativePath,
        startLine: range?.startLine ?? 1,
        endLine: Math.max(range?.endLine ?? 1, range?.startLine ?? 1),
      },
      diagnostics: candidateDiagnostics,
    });
  }

  for (const rpc of rpcs) {
    const qualified = rpc.service + "." + rpc.name;
    const candidateDiagnostics: string[] = [];
    if (rpc.streamUsed) {
      candidateDiagnostics.push(
        "protobuf: stream rpc akış semantiği sınırlı dilim ötesinde — serializer unknown",
      );
    }
    contracts.push({
      contractId: nodeId({
        workspaceId,
        kind: "ApiContract",
        qualifiedName: qualified,
        relativePath,
      }),
      sourceKind: "protobuf",
      nodeKind: "ApiContract",
      name: qualified,
      qualifiedName: qualified,
      method: "RPC",
      responseSchemaIds: [rpc.responseType],
      properties: [],
      requiredPropertyNames: [],
      resolvedRefs: [],
      certainty: filePartial || rpc.streamUsed ? "partial" : "full",
      evidence: { relativePath, startLine: rpc.line, endLine: rpc.line },
      diagnostics: candidateDiagnostics,
      ...(rpc.requestType.length === 0 ? {} : { requestSchemaId: rpc.requestType }),
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
