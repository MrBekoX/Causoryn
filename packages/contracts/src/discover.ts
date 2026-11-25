import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";

import { parseDocument } from "yaml";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { discoverAsyncApiContracts } from "./asyncapi-discovery.js";
import { ContractDiscoveryError, type ContractErrorCode } from "./errors.js";
import { discoverJsonSchemaContracts } from "./json-schema-discovery.js";
import { discoverOpenApiContracts } from "./openapi-discovery.js";
import { discoverProtobufContracts } from "./protobuf-discovery.js";
import { discoverSqlContracts } from "./sql-discovery.js";
import {
  assertSpecTextPrechecks,
  describeSpecParserFailure,
  describeSpecSyntaxError,
  isPlainObject,
} from "./parse-safety.js";
import { compareContractCandidates, compareDiagnostics, compareStrings } from "./order.js";
import type {
  ContractCandidate,
  ContractDiagnostic,
  ContractDiscoveryResult,
  ContractFileInput,
  DiscoveryOutput,
} from "./types.js";

/**
 * Keşif orkestrasyonu — sprint-5 D1 gereği (4): "WorkspaceAccessPolicy ile
 * salt-okunur dosya erişimi (policy dışı file okunmaz)".
 *
 * - `discoverContractsFromTexts`: SAF çekirdek — fs/thread/saat okumaz.
 *   Uzantıya göre yönlendirir (.yaml/.yml → kök anahtar kokusuyla
 *   openapi/asyncapi/json-schema; .json → json-schema; .sql → sql;
 *   .proto → protobuf). Tanınmayan uzantı →
 *   contracts/unsupported-spec-content diagnostic'ı (sözleşme üretilmez).
 *   Parse/şema hataları FAIL-FAST fırlatılır (açık reddi; TŞ §11 disiplini).
 * - `readContractFiles`: tek fs dokunan katman. Her aday önce
 *   WorkspaceAccessPolicy.checkFile'dan geçer (yetki → traversal → ignore →
 *   symlink → uzantı → boyut); policy reddi ContractDiscoveryError olarak
 *   yüzeye taşınır. Ek savunma katmanları (TŞ §19 sözleşmesi):
 *   (a) resolve edilmiş hedef, okuma ÖNCESİ kök sarmalamasına tabi tutulur;
 *   (b) dosya AÇILDIKTAN SONRA gerçek yol (realpath) YENİDEN denetlenir
 *   (TOCTOU penceresi) ve okuma kanonik gerçek yoldan yapılır.
 */

function sniffsAsJsonSchema(root: Record<string, unknown>): boolean {
  return (
    typeof root["$schema"] === "string" ||
    isPlainObject(root["properties"]) ||
    isPlainObject(root["$defs"]) ||
    isPlainObject(root["definitions"]) ||
    typeof root["type"] === "string"
  );
}

function extensionOf(relativePath: string): string {
  return path.extname(relativePath).toLowerCase();
}

type SniffResult =
  | { readonly ok: true; readonly root: unknown }
  | {
      readonly ok: false;
      /** Ön katman/parse reddinin açık kodu (ContractErrorCode). */
      readonly code: ContractErrorCode;
      readonly error: string;
    };

function sniffYamlRoot(text: string): SniffResult {
  // Ön katmanlar (boyut/derinlik/alias) parse'dan ÖNCE uygulanır —
  // parse-safety.ts'teki belgelenmiş katman sırası sniff yolunda da geçerlidir
  // (takım denetimi bulgusu 2). Ayrıntılı şema reddi keşif fonksiyonundadır;
  // burada yalnızca kök şekli görülür.
  try {
    assertSpecTextPrechecks(text);
  } catch (error) {
    if (error instanceof ContractDiscoveryError) {
      return { ok: false, code: error.code, error: error.message };
    }
    throw error;
  }
  try {
    const document = parseDocument(text);
    if (document.errors.length > 0) {
      const first = document.errors[0];
      return {
        ok: false,
        code: "contracts/spec-yaml-invalid",
        error: "YAML syntax error: " + describeSpecSyntaxError(first),
      };
    }
    return { ok: true, root: document.toJS() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      // yaml kütüphanesinin alias limiti ReferenceError'ı sniff toJS'inde
      // aşar — parse-safety ile aynı eşleme: alias → limit-exceeded.
      code: message.includes("alias") ? "contracts/limit-exceeded" : "contracts/spec-yaml-invalid",
      error: "YAML could not be parsed: " + describeSpecParserFailure(error),
    };
  }
}

export function discoverContractsFromTexts(
  workspaceId: string,
  files: readonly ContractFileInput[],
): ContractDiscoveryResult {
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    throw new ContractDiscoveryError("contracts/invalid-input", "workspaceId must not be empty");
  }

  const contracts: ContractCandidate[] = [];
  const diagnostics: ContractDiagnostic[] = [];

  // Determinizm: girdi sırasından bağımsız işlem sırası (kanonik yol sırası).
  const sorted = [...files].sort((a, b) => compareStrings(a.relativePath, b.relativePath));

  for (const file of sorted) {
    if (typeof file.relativePath !== "string" || file.relativePath.trim().length === 0) {
      throw new ContractDiscoveryError(
        "contracts/invalid-input",
        "relativePath must not be empty (invalid entry in the file list)",
      );
    }
    const extension = extensionOf(file.relativePath);
    let output: DiscoveryOutput;

    if (extension === ".yaml" || extension === ".yml") {
      const sniff = sniffYamlRoot(file.text);
      if (!sniff.ok) {
        // Ön katman kotası veya YAML sözdizimi: keşif fonksiyonuna
        // bırakmadan AÇIK reddi ver (katman sırası korunur).
        throw new ContractDiscoveryError(sniff.code, file.relativePath + ": " + sniff.error);
      }
      if (!isPlainObject(sniff.root)) {
        throw new ContractDiscoveryError(
          "contracts/spec-invalid",
          file.relativePath + ": YAML root is not a mapping (object)",
        );
      }
      if (typeof sniff.root["openapi"] === "string") {
        output = discoverOpenApiContracts(workspaceId, file.relativePath, file.text);
      } else if (typeof sniff.root["asyncapi"] === "string") {
        output = discoverAsyncApiContracts(workspaceId, file.relativePath, file.text);
      } else if (sniffsAsJsonSchema(sniff.root)) {
        output = discoverJsonSchemaContracts(workspaceId, file.relativePath, file.text);
      } else {
        diagnostics.push({
          relativePath: file.relativePath,
          code: "contracts/unsupported-spec-content",
          message: "YAML root has no openapi/asyncapi/JSON Schema marker; no contract produced",
          line: 1,
        });
        continue;
      }
    } else if (extension === ".json") {
      output = discoverJsonSchemaContracts(workspaceId, file.relativePath, file.text);
    } else if (extension === ".sql") {
      output = discoverSqlContracts(workspaceId, file.relativePath, file.text);
    } else if (extension === ".proto") {
      output = discoverProtobufContracts(workspaceId, file.relativePath, file.text);
    } else {
      diagnostics.push({
        relativePath: file.relativePath,
        code: "contracts/unsupported-spec-content",
        message: "Unsupported spec extension: " + (extension === "" ? "(no extension)" : extension),
        line: 1,
      });
      continue;
    }

    contracts.push(...output.contracts);
    diagnostics.push(...output.diagnostics);
  }

  return {
    workspaceId,
    contracts: [...contracts].sort(compareContractCandidates),
    diagnostics: [...diagnostics].sort(compareDiagnostics),
    analyzerId: "contracts-discovery",
    analyzerVersion: "0.1.0",
  };
}

/** Kök sarmalama denetimi (resolve edilmiş yol için; TŞ §19 re-check 1). */
function isInsideRoot(root: string, target: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const r = normalize(root);
  const t = normalize(target);
  if (t === r) return true;
  const boundary = r.endsWith(path.sep) ? r : r + path.sep;
  return t.startsWith(boundary);
}

export async function readContractFiles(
  root: string,
  policy: WorkspaceAccessPolicy,
  relativePaths: readonly string[],
): Promise<ContractFileInput[]> {
  const files: ContractFileInput[] = [];
  const sorted = [...relativePaths].sort(compareStrings);

  for (const candidate of sorted) {
    const decision = policy.checkFile(root, candidate);
    if (!decision.allowed) {
      throw new ContractDiscoveryError(
        decision.code === "workspace/limit-exceeded"
          ? "contracts/limit-exceeded"
          : "contracts/file-not-authorized",
        "Read-only spec access denied (" + candidate + "): " + decision.reason +
          (decision.rule === undefined ? "" : " [rule: " + decision.rule + "]"),
      );
    }

    // (a) okuma öncesi resolve + kök sınırı doğrulaması
    const target = path.resolve(decision.canonicalRoot, decision.relativePath);
    if (target !== decision.canonicalRoot && !target.startsWith(decision.canonicalRoot + path.sep)) {
      throw new ContractDiscoveryError(
        "contracts/file-not-authorized",
        "Spec file resolved outside the root: " + candidate,
      );
    }

    // (b) açma sonrası gerçek yol re-check + kanonik yoldan okuma
    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      throw new ContractDiscoveryError(
        "contracts/file-not-authorized",
        "Could not resolve the real path of the spec file to open: " + candidate,
      );
    }
    if (!isInsideRoot(decision.canonicalRoot, real)) {
      throw new ContractDiscoveryError(
        "contracts/file-not-authorized",
        "Real path of the opened spec file is outside the root (TOCTOU re-check): " + candidate,
      );
    }
    const text = await readFile(real, "utf8");
    files.push({ relativePath: decision.relativePath, text });
  }
  return files;
}
