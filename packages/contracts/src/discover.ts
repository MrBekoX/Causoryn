import path from "node:path";

import { parseDocument } from "yaml";
import { readBoundedTextFile, WorkspaceAccessPolicy, type PolicyDecision } from "@causoryn/workspace";

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
 *   yüzeye taşınır. Ek savunma katmanları (TŞ §19 sözleşmesi; CAU-02):
 *   (a) resolve edilmiş hedef, okuma ÖNCESİ kök sarmalamasına tabi tutulur;
 *   (b) okuma paylaşılan `readBoundedTextFile` ile tek fd üzerinden yapılır:
 *   kökten aşağı lstat yürüyüşü, yalnızca düzenli dosya, fstat kimliği
 *   (dev, ino) ön-lstat ve açma sonrası yeniden doğrulama ile aynı,
 *   `maxFileBytes + 1` ile sınırlı okuma; (c) fd AÇIKKEN policy kararı, fd
 *   ile doğrulanmış boyutla YENİDEN alınır ve aynı kanonik yolu vermelidir.
 *   Kimlik/tip uyuşmazlığı → contracts/file-not-authorized; bayt taşması →
 *   contracts/limit-exceeded.
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

    // (b)+(c) fd'ye bağlı okuma; policy kararı fd açıkken yeniden alınır.
    const maxBytes = policy.config.maxFileBytes;
    const post: { decision?: PolicyDecision } = {};
    const read = await readBoundedTextFile(target, maxBytes, {
      root: decision.canonicalRoot,
      authorize: (opened) => {
        const postDecision = policy.checkFile(root, candidate, opened.bytes);
        post.decision = postDecision;
        return postDecision.allowed && postDecision.relativePath === decision.relativePath;
      },
    });
    if (read.status === "too-large") {
      throw new ContractDiscoveryError(
        "contracts/limit-exceeded",
        "Spec file exceeds the maxFileBytes limit (" + String(read.bytes) + " > " + String(maxBytes) +
          " bytes): " + candidate,
      );
    }
    if (read.status === "rejected") {
      const postDecision = post.decision;
      const overLimit = postDecision?.allowed === false && postDecision.code === "workspace/limit-exceeded";
      throw new ContractDiscoveryError(
        overLimit ? "contracts/limit-exceeded" : "contracts/file-not-authorized",
        "Spec file could not be read through a verified descriptor (" + read.reason + "): " + candidate,
      );
    }
    files.push({ relativePath: decision.relativePath, text: read.text });
  }
  return files;
}
