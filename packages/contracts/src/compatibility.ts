import { ContractDiscoveryError } from "./errors.js";
import { compareContractCandidates, compareStrings, sortUnique } from "./order.js";
import { isPlainObject } from "./parse-safety.js";
import type {
  ContractCandidate,
  ContractDiagnostic,
  ContractEvidenceSpan,
  DiscoveryOutput,
} from "./types.js";

/**
 * Sözleşme uyumluluk çekirdeği — TŞ v2.1 §11 (Architecture Contracts ve
 * Contract Drift, s.11–12) ve sprint-5 D2 (`causoryn_check_contracts`
 * aracının saf çekirdeği; MCP yüzeyi D3 orkestrasyonundadır).
 *
 * TŞ §11 temel cümleler (pdftotext s.11–12 doğrulaması):
 *  - "zorunlu property silinmesi → breaking_candidate"
 *  - "nullable → required → risk"
 *  - "Server yalnızca statik delili ifade eder, sözleşme uyumluluğu
 *    framework/serializer/runtime'a göre farklılaşabileceğinden unknown
 *    üretebilir."
 *  - "DB kolon kaldırma → tüketiciler için aday etki"
 *
 * BELGELİ KURAL KATALOĞU (deterministik; her bulgu kural adı + kanıt taşır):
 *
 * | ruleId                        | Sınıflama         | Tetik (keşif sadakatiyle) |
 * |-------------------------------|-------------------|---------------------------|
 * | required-property-removed     | breaking_candidate| base'te zorunlu property, target'ta hiç yok (TŞ §11 kural 1) |
 * | required-property-relaxed     | backward-safe     | property korunur, yalnızca zorunluluk gevşer (required→optional; eski gönderenler hâlâ geçerli) |
 * | optional-property-added       | backward-safe     | base'te olmayan opsiyonel property target'ta var (TŞ kural 3: yeni opsiyonel alan) |
 * | optional-property-made-required| risk             | base'te opsiyonel olan property target'ta zorunlu (TŞ §11 "nullable→required→risk"in keşif sadakatindeki karşılığı; keşif nullable bayrağı taşımaz, required listesi taşır) |
 * | added-required-property       | risk              | target'ta YENİ zorunlu property (eski üreticiler göndermez; TŞ breaking_candidate saymadığı için risk düzeyinde işaretlenir) |
 * | optional-property-removed     | risk              | opsiyonel property target'ta yok (ekleme kuralının tersi; breaking iddiası TŞ'de sayılmadığı için risk) |
 * | removed-endpoint              | breaking_candidate| endpoint (route'ın TÜM metotları) target'ta yok (TŞ kural 4) |
 * | method-changed                | breaking_candidate| route her iki tarafta var ama base'deki bir metot target'ta yok (TŞ kural 4) |
 * | added-endpoint                | backward-safe     | target'ta yeni route/metot (ekleme; K-013(7) changeKind "added" ile hizalı) |
 * | removed-contract              | breaking_candidate| endpoint olmayan sözleşmenin tamamı target'ta yok (kural 1'in sözleşme ölçeğindeki türevi: tüm zorunlu property'lerin silinmesi) |
 * | added-contract                | backward-safe     | target'ta yeni sözleşme |
 * | column-dropped                | breaking_candidate| target diagnostics'ında contracts/sql-drop-column (TŞ §11: DB kolon kaldırma → tüketici etkisi) |
 * | column-renamed                | unknown           | contracts/sql-rename-column — TŞ §11 rename için sınıflama saymaz; uydurma karar YOK |
 * | table-renamed                 | unknown           | contracts/sql-rename-table — aynı gerekçe |
 * | serializer-unknown            | unknown           | aday diagnostics'ında "serializer unknown" işareti (protobuf-discovery sözleşmesi; TŞ §11 unknown hükmü) |
 * | discovery-partial             | unknown           | certainty=partial aday yüzünden değeri güvenle söylenemeyen kural değerlendirmeleri bastırıldı (uydurma güven yok) |
 * | no-change-detected            | backward-safe     | çift bu kural setinde yapısal fark üretmedi |
 *
 * ŞİDDET SIRASI (toplam sınıflama için): breaking_candidate > risk >
 * unknown > backward-safe. unknown, görülemeyeni ifade eder; görülen yapısal
 * breaking delilini gizlemez (iki bulgu ayrı ayrı taşınır).
 *
 * KEŞİF SADAKATİ SINIRLARI (dürüstlük):
 * - OpenAPI keşfi (openapi-discovery.ts) ApiContract adayına yalnızca
 *   REQUEST şemasının property'lerini taşır; yanıt şeması drift'i şema
 *   düzeyindeki adaylarla (SchemaContract) değerlendirilir.
 * - "certainty=partial" adayın property LİSTESİ eksik olabilir (örn. ALTER
 *   -only SQL dosyası tabloyu yeniden söylemez): eksik-liste yüzünden
 *   "silindi" İDDİASI üretilemez; bu durumda kural bastırılır ve
 *   discovery-partial (unknown) bulgusu düşer — pozitif gözlem (var olan
 *   property) üzerinden kurallar yine değerlendirilir.
 * - changeKind değerleri K-013(7) gövdesiyle hizalıdır
 *   (added|removed|modified; değişmeyen çift için "unchanged").
 *
 * SAF ÇEKİRDEK: fs/thread/saat/rastgele okumaz; girdileri mutasyona
 * uğratmaz; tüm sıralamalar kod noktası (codepoint) sırasındadır
 * (localeCompare ASLA yok — TŞ §8 invariant vi: aynı giriş → aynı çıktı).
 */

/** Uyumluluk sınıflaması — TŞ §11 sözlüğü + sprint-5 D2 gereği "unknown". */
export type ContractCompatibilityClassification =
  | "backward-safe"
  | "risk"
  | "breaking_candidate"
  | "unknown";

/** K-013(7) contractChanges gövdesiyle hizalı değişim türü. */
export type ContractChangeKind = "added" | "removed" | "modified" | "unchanged";

/** Tek kural değerlendirmesi: kural adı + sınıflama + gerekçe + kanıt. */
export interface ContractCompatibilityFinding {
  /** Yukarıdaki belgeli kural kataloğundaki kimlik. */
  readonly ruleId: string;
  readonly classification: ContractCompatibilityClassification;
  /** İnsan-okur gerekçe (deterministik metin; property-kapsamlı kurallarda alan adı içerir). */
  readonly summary: string;
  /** Property-kapsamlı kurallarda alan/kolon adı; diğer kurallarda yoktur. */
  readonly property?: string;
  /**
   * Kanıt: ESKİ (base) satır referansları önce, YENİ (target) sonrası;
   * tek taraflı kurallarda yalnızca ilgili taraf (TŞ §8 Evidence First).
   */
  readonly evidence: readonly ContractEvidenceSpan[];
}

/** Bir sözleşme kimliği (matchKey) için toplu değerlendirme. */
export interface ContractPairEvaluation {
  /**
   * Kararlı eşleştirme anahtarı: endpoint'ler için "<METHOD> <route>";
   * diğer adaylar için "<sourceKind> <nodeKind> <qualifiedName>".
   * contractId bilinçli olarak KULLANILMAZ: aynı sözleşmenin farklı sürüm
   * dosyaları ayrık kimlik alır (types.ts ContractCandidate sözleşmesi).
   */
  readonly matchKey: string;
  readonly sourceKind: ContractCandidate["sourceKind"];
  readonly nodeKind: ContractCandidate["nodeKind"];
  readonly name: string;
  readonly changeKind: ContractChangeKind;
  readonly baseContractId?: string;
  readonly targetContractId?: string;
  readonly classification: ContractCompatibilityClassification;
  /** Kural adı + kanıt taşıyan bulgular (deterministik sıralı). */
  readonly findings: readonly ContractCompatibilityFinding[];
}

/** İki keşif çıktısı arasındaki tam uyumluluk raporu. */
export interface ContractCompatibilityReport {
  /** Tüm çift/bulgu değerlendirmelerinin en şiddetlisi; boş girdide "backward-safe" (boş gerçek: değerlendirilecek sözleşme yok). */
  readonly classification: ContractCompatibilityClassification;
  /** matchKey'e göre deterministik sıralı. */
  readonly evaluations: readonly ContractPairEvaluation[];
  /**
   * Hiçbir çifte bağlanamayan hedef diagnostics bulguları (örn. adı
   * eşleşmeyen tablo kolon değişimi); sessizce bırakılmaz.
   */
  readonly unattachedFindings: readonly ContractCompatibilityFinding[];
}

const CLASSIFICATION_SEVERITY: Readonly<
  Record<ContractCompatibilityClassification, number>
> = {
  "backward-safe": 0,
  unknown: 1,
  risk: 2,
  breaking_candidate: 3,
};

/** changeKind'ı "modified" yapmayan değerlendirme-sınırı bulguları. */
const ASSESSMENT_MARKER_RULES: ReadonlySet<string> = new Set([
  "serializer-unknown",
  "discovery-partial",
  "no-change-detected",
]);

/** sql-discovery.ts'in belgeli diagnostic kodlarından kural eşlemesi. */
const SQL_DIAGNOSTIC_RULES: ReadonlyMap<
  string,
  { readonly ruleId: string; readonly classification: ContractCompatibilityClassification }
> = new Map([
  ["contracts/sql-drop-column", { ruleId: "column-dropped", classification: "breaking_candidate" }],
  ["contracts/sql-rename-column", { ruleId: "column-renamed", classification: "unknown" }],
  ["contracts/sql-rename-table", { ruleId: "table-renamed", classification: "unknown" }],
]);

/** sql-discovery.ts mesaj biçimi: "ALTER TABLE <table> <action> ...". */
const SQL_TABLE_NAME_PATTERN = /^ALTER\s+TABLE\s+([A-Za-z_][\w$]*)/iu;
/** "DROP COLUMN <name>" / "RENAME COLUMN <from> TO <to>" kolon adı yakalama. */
const SQL_DROP_COLUMN_PATTERN = /DROP\s+(?:COLUMN\s+)?([A-Za-z_][\w$]*)/iu;
const SQL_RENAME_COLUMN_PATTERN = /RENAME\s+(?:COLUMN\s+)?([A-Za-z_][\w$]*)\s+TO\s+([A-Za-z_][\w$]*)/iu;

const SERIALIZER_UNKNOWN_MARKER = "serializer unknown";

/* ------------------------------------------------------------------ */
/* Yardımcılar (tamamı saf ve deterministik)                           */
/* ------------------------------------------------------------------ */

function assertValidDiscoveryOutput(value: unknown, label: string): DiscoveryOutput {
  if (!isPlainObject(value) || !Array.isArray(value["contracts"]) || !Array.isArray(value["diagnostics"])) {
    throw new ContractDiscoveryError(
      "contracts/invalid-input",
      `${label} DiscoveryOutput failed validation (contracts/invalid-input): the contracts and diagnostics arrays are required`,
    );
  }
  return value as unknown as DiscoveryOutput;
}

function assertValidCandidate(value: unknown, label: string): ContractCandidate {
  if (
    !isPlainObject(value) ||
    !Array.isArray(value["properties"]) ||
    !Array.isArray(value["diagnostics"]) ||
    !isPlainObject(value["evidence"])
  ) {
    throw new ContractDiscoveryError(
      "contracts/invalid-input",
      `${label} ContractCandidate failed validation (contracts/invalid-input): the properties/diagnostics arrays and evidence are required`,
    );
  }
  return value as unknown as ContractCandidate;
}

/** Kararlı eşleştirme anahtarı (belgelenmiş biçim; bkz. ContractPairEvaluation). */
function stableKey(candidate: ContractCandidate): string {
  if (candidate.method !== undefined && candidate.route !== undefined) {
    return `${candidate.method} ${candidate.route}`;
  }
  return `${candidate.sourceKind} ${candidate.nodeKind} ${candidate.qualifiedName}`;
}

function isEndpointCandidate(candidate: ContractCandidate): boolean {
  return candidate.nodeKind === "ApiContract" && candidate.method !== undefined && candidate.route !== undefined;
}

function maxClassification(
  findings: readonly ContractCompatibilityFinding[],
): ContractCompatibilityClassification {
  let best: ContractCompatibilityClassification = "backward-safe";
  for (const finding of findings) {
    if (CLASSIFICATION_SEVERITY[finding.classification] > CLASSIFICATION_SEVERITY[best]) {
      best = finding.classification;
    }
  }
  return best;
}

function compareFindings(a: ContractCompatibilityFinding, b: ContractCompatibilityFinding): number {
  return (
    compareStrings(a.ruleId, b.ruleId) ||
    compareStrings(a.property ?? "", b.property ?? "") ||
    compareStrings(a.summary, b.summary)
  );
}

function sortedMapKeys(map: ReadonlyMap<string, unknown>): string[] {
  return sortUnique([...map.keys()], compareStrings);
}

/** Kanonik sırayla ön-sıralanmış listeden anahtar başına ilk adayı alır. */
function firstWins(
  candidates: readonly ContractCandidate[],
  keyOf: (candidate: ContractCandidate) => string,
): Map<string, ContractCandidate> {
  const map = new Map<string, ContractCandidate>();
  for (const candidate of candidates) {
    const key = keyOf(candidate);
    if (!map.has(key)) map.set(key, candidate);
  }
  return map;
}

function lineSpan(diagnostic: ContractDiagnostic): ContractEvidenceSpan {
  return {
    relativePath: diagnostic.relativePath,
    startLine: diagnostic.line,
    endLine: diagnostic.line,
  };
}

/* ------------------------------------------------------------------ */
/* Çift düzeyi çekirdek                                                */
/* ------------------------------------------------------------------ */

/**
 * İki sözleşme sürümünü (base → target) belgeli kural kataloğuyla
 * değerlendirir. Saf: girdileri okur, hiçbir şeyi mutasyona uğratmaz.
 */
export function evaluateContractPair(
  baseInput: ContractCandidate,
  targetInput: ContractCandidate,
): ContractPairEvaluation {
  const base = assertValidCandidate(baseInput, "base");
  const target = assertValidCandidate(targetInput, "target");

  const baseFull = base.certainty === "full";
  const targetFull = target.certainty === "full";
  const bothFull = baseFull && targetFull;
  const pairEvidence: readonly ContractEvidenceSpan[] = [base.evidence, target.evidence];

  const findings: ContractCompatibilityFinding[] = [];
  const suppressed: string[] = [];

  // serializer-unknown işareti (protobuf-discovery aday sözleşmesi; TŞ §11:
  // uyumluluk serializer/runtime'a göre farklılaşabilir → unknown).
  const markers = sortUnique(
    [...base.diagnostics, ...target.diagnostics].filter((entry) =>
      entry.includes(SERIALIZER_UNKNOWN_MARKER),
    ),
    compareStrings,
  );
  if (markers.length > 0) {
    findings.push({
      ruleId: "serializer-unknown",
      classification: "unknown",
      summary:
        "serializer/unknown-structure marker: " +
        markers.join(" | ") +
        " — compatibility can differ by serializer/runtime, so the result is unknown",
      evidence: pairEvidence,
    });
  }

  const baseProps = new Map<string, ContractCandidate["properties"][number]>();
  for (const property of base.properties) baseProps.set(property.name, property);
  const targetProps = new Map<string, ContractCandidate["properties"][number]>();
  for (const property of target.properties) targetProps.set(property.name, property);

  for (const name of sortUnique([...baseProps.keys(), ...targetProps.keys()], compareStrings)) {
    const before = baseProps.get(name);
    const after = targetProps.get(name);

    if (before !== undefined && after !== undefined) {
      if (before.required && !after.required) {
        if (bothFull) {
          findings.push({
            ruleId: "required-property-relaxed",
            classification: "backward-safe",
            summary:
              `property "${name}" exists in both versions; only its requiredness was relaxed ` +
              "(required→optional) — existing senders remain valid",
            property: name,
            evidence: pairEvidence,
          });
        } else {
          suppressed.push(`${name} (required-property-relaxed)`);
        }
      }
      if (!before.required && after.required) {
        if (baseFull) {
          findings.push({
            ruleId: "optional-property-made-required",
            classification: "risk",
            summary:
              `property "${name}" was optional in base and is required in target ` +
              "(nullable→required → risk; discovery tracks the required list, not nullability)",
            property: name,
            evidence: pairEvidence,
          });
        } else {
          suppressed.push(`${name} (optional-property-made-required)`);
        }
      }
      continue;
    }

    if (before !== undefined && after === undefined) {
      if (bothFull) {
        findings.push(
          before.required
            ? {
                ruleId: "required-property-removed",
                classification: "breaking_candidate",
                summary:
                  `required property "${name}" is missing in the target version ` +
                  "(removing a required property → breaking_candidate)",
                property: name,
                evidence: pairEvidence,
              }
            : {
                ruleId: "optional-property-removed",
                classification: "risk",
                summary:
                  `optional property "${name}" is missing in the target version — the inverse of the ` +
                  "optional-addition rule; flagged as risk (not counted as a breaking change)",
                property: name,
                evidence: pairEvidence,
              },
        );
      } else {
        suppressed.push(
          before.required
            ? `${name} (required-property-removed)`
            : `${name} (optional-property-removed)`,
        );
      }
      continue;
    }

    if (before === undefined && after !== undefined) {
      if (baseFull) {
        findings.push(
          after.required
            ? {
                ruleId: "added-required-property",
                classification: "risk",
                summary:
                  `NEW required property "${name}" in target — existing producers do not send it; ` +
                  "flagged as risk (not counted as a breaking change)",
                property: name,
                evidence: pairEvidence,
              }
            : {
                ruleId: "optional-property-added",
                classification: "backward-safe",
                summary:
                  `new optional property "${name}" (rule: a new optional field → ` +
                  "backward-safe)",
                property: name,
                evidence: pairEvidence,
              },
        );
      } else {
        suppressed.push(
          after.required ? `${name} (added-required-property)` : `${name} (optional-property-added)`,
        );
      }
    }
  }

  if (suppressed.length > 0) {
    findings.push({
      ruleId: "discovery-partial",
      classification: "unknown",
      summary:
        "these rule evaluations rely on a complete property list and were suppressed because " +
        "a candidate has certainty=partial (no fabricated claim was produced): " +
        suppressed.join(", "),
      evidence: pairEvidence,
    });
  }

  if (findings.length === 0) {
    findings.push({
      ruleId: "no-change-detected",
      classification: "backward-safe",
      summary: "no structural difference found under this rule set — backward-safe",
      evidence: pairEvidence,
    });
  }

  findings.sort(compareFindings);

  const hasChangeFinding = findings.some((finding) => !ASSESSMENT_MARKER_RULES.has(finding.ruleId));
  return {
    matchKey: stableKey(base),
    sourceKind: base.sourceKind,
    nodeKind: base.nodeKind,
    name: base.name,
    changeKind: hasChangeFinding ? "modified" : "unchanged",
    baseContractId: base.contractId,
    targetContractId: target.contractId,
    classification: maxClassification(findings),
    findings,
  };
}

/* ------------------------------------------------------------------ */
/* Rapor düzeyi çekirdek                                               */
/* ------------------------------------------------------------------ */

/**
 * İki keşif çıktısını (base → target) çiftlere ayırıp değerlendirir:
 * endpoint'ler route+metot düzeyinde (metot değişimi/ekleme/silme ayrımı
 * için), diğer adaylar kararlı anahtarla eşleşir. Hedef diagnostics'ındaki
 * SQL kolon değişim olayları ilgili tablo çiftine bağlanır; bağlanamayan
 * bulgu unattachedFindings'te ayrı raporlanır.
 */
export function checkContractCompatibility(
  baseInput: DiscoveryOutput,
  targetInput: DiscoveryOutput,
): ContractCompatibilityReport {
  const base = assertValidDiscoveryOutput(baseInput, "base");
  const target = assertValidDiscoveryOutput(targetInput, "target");

  // Determinizm: girdi sırasından bağımsız işlem (kanonik aday sırası).
  const baseSorted = [...base.contracts].sort(compareContractCandidates);
  const targetSorted = [...target.contracts].sort(compareContractCandidates);

  const evaluations: ContractPairEvaluation[] = [];

  /* --- endpoint bucket: route → metot → aday ----------------------- */
  const baseRoutes = new Map<string, Map<string, ContractCandidate>>();
  const targetRoutes = new Map<string, Map<string, ContractCandidate>>();
  for (const [routes, candidate] of [
    [baseRoutes, baseSorted],
    [targetRoutes, targetSorted],
  ] as const) {
    for (const entry of candidate) {
      if (!isEndpointCandidate(entry)) continue;
      const route = entry.route as string;
      const method = entry.method as string;
      let byMethod = routes.get(route);
      if (byMethod === undefined) {
        byMethod = new Map<string, ContractCandidate>();
        routes.set(route, byMethod);
      }
      if (!byMethod.has(method)) byMethod.set(method, entry); // ilk-kazanır (kanonik sıra)
    }
  }

  const evaluateEndpointRemoval = (
    candidate: ContractCandidate,
    ruleId: "removed-endpoint" | "method-changed",
    targetSpan: ContractEvidenceSpan | undefined,
  ): ContractPairEvaluation => ({
    matchKey: stableKey(candidate),
    sourceKind: candidate.sourceKind,
    nodeKind: candidate.nodeKind,
    name: candidate.name,
    changeKind: "removed",
    baseContractId: candidate.contractId,
    classification: "breaking_candidate",
    findings: [
      {
        ruleId,
        classification: "breaking_candidate",
        summary:
          ruleId === "removed-endpoint"
            ? `endpoint removed: ${candidate.method} ${candidate.route} (rule: removing an endpoint → breaking_candidate)`
            : `method changed on route: ${candidate.method} ${candidate.route} is missing in the target; the route remains in the target with other methods (rule: a method change → breaking_candidate)`,
        evidence: targetSpan === undefined ? [candidate.evidence] : [candidate.evidence, targetSpan],
      },
    ],
  });

  const addedEndpointEvaluation = (candidate: ContractCandidate): ContractPairEvaluation => ({
    matchKey: stableKey(candidate),
    sourceKind: candidate.sourceKind,
    nodeKind: candidate.nodeKind,
    name: candidate.name,
    changeKind: "added",
    targetContractId: candidate.contractId,
    classification: "backward-safe",
    findings: [
      {
        ruleId: "added-endpoint",
        classification: "backward-safe",
        summary: `new endpoint in target: ${candidate.method} ${candidate.route} (addition; does not affect existing clients)`,
        evidence: [candidate.evidence],
      },
    ],
  });

  for (const route of sortedMapKeys(baseRoutes)) {
    const baseByMethod = baseRoutes.get(route);
    if (baseByMethod === undefined) continue;
    const targetByMethod = targetRoutes.get(route);

    if (targetByMethod === undefined) {
      // Route'ın TÜM metotları silinmiş: endpoint silme.
      for (const method of sortedMapKeys(baseByMethod)) {
        const candidate = baseByMethod.get(method);
        if (candidate !== undefined) {
          evaluations.push(evaluateEndpointRemoval(candidate, "removed-endpoint", undefined));
        }
      }
      continue;
    }

    for (const method of sortedMapKeys(baseByMethod)) {
      const baseCandidate = baseByMethod.get(method);
      if (baseCandidate === undefined) continue;
      const targetCandidate = targetByMethod.get(method);
      if (targetCandidate !== undefined) {
        evaluations.push(evaluateContractPair(baseCandidate, targetCandidate));
      } else {
        // Metot değişimi: route yaşıyor ama bu metot yok.
        const surviving = sortedMapKeys(targetByMethod)
          .map((entry) => targetByMethod.get(entry))
          .filter((entry): entry is ContractCandidate => entry !== undefined);
        evaluations.push(
          evaluateEndpointRemoval(baseCandidate, "method-changed", surviving[0]?.evidence),
        );
      }
    }

    // Mevcut route'a EKLENEN metotlar: added-endpoint (backward-safe ekleme).
    for (const method of sortedMapKeys(targetByMethod)) {
      if (baseByMethod.has(method)) continue;
      const candidate = targetByMethod.get(method);
      if (candidate !== undefined) {
        evaluations.push(addedEndpointEvaluation(candidate));
      }
    }
  }

  for (const route of sortedMapKeys(targetRoutes)) {
    if (baseRoutes.has(route)) continue;
    const targetByMethod = targetRoutes.get(route);
    if (targetByMethod === undefined) continue;
    for (const method of sortedMapKeys(targetByMethod)) {
      const candidate = targetByMethod.get(method);
      if (candidate !== undefined) {
        evaluations.push(addedEndpointEvaluation(candidate));
      }
    }
  }

  /* --- endpoint olmayan bucket: kararlı anahtar --------------------- */
  const baseOther = firstWins(
    baseSorted.filter((candidate) => !isEndpointCandidate(candidate)),
    stableKey,
  );
  const targetOther = firstWins(
    targetSorted.filter((candidate) => !isEndpointCandidate(candidate)),
    stableKey,
  );

  for (const key of sortUnique([...baseOther.keys(), ...targetOther.keys()], compareStrings)) {
    const baseCandidate = baseOther.get(key);
    const targetCandidate = targetOther.get(key);
    if (baseCandidate !== undefined && targetCandidate !== undefined) {
      evaluations.push(evaluateContractPair(baseCandidate, targetCandidate));
      continue;
    }
    if (baseCandidate !== undefined) {
      evaluations.push({
        matchKey: key,
        sourceKind: baseCandidate.sourceKind,
        nodeKind: baseCandidate.nodeKind,
        name: baseCandidate.name,
        changeKind: "removed",
        baseContractId: baseCandidate.contractId,
        classification: "breaking_candidate",
        findings: [
          {
            ruleId: "removed-contract",
            classification: "breaking_candidate",
            summary:
              `the entire contract is missing in target: ${key} — the contract-level form of the ` +
              "required-property-removal rule",
            evidence: [baseCandidate.evidence],
          },
        ],
      });
      continue;
    }
    if (targetCandidate !== undefined) {
      evaluations.push({
        matchKey: key,
        sourceKind: targetCandidate.sourceKind,
        nodeKind: targetCandidate.nodeKind,
        name: targetCandidate.name,
        changeKind: "added",
        targetContractId: targetCandidate.contractId,
        classification: "backward-safe",
        findings: [
          {
            ruleId: "added-contract",
            classification: "backward-safe",
            summary: `new contract in target: ${key} (addition; changeKind added)`,
            evidence: [targetCandidate.evidence],
          },
        ],
      });
    }
  }

  /* --- hedef diagnostics'ındaki SQL kolon/tablo olayları ------------ */
  const unattachedFindings: ContractCompatibilityFinding[] = [];
  const byMatchKey = new Map<string, ContractPairEvaluation>();
  for (const evaluation of evaluations) byMatchKey.set(evaluation.matchKey, evaluation);

  for (const diagnostic of target.diagnostics) {
    const rule = SQL_DIAGNOSTIC_RULES.get(diagnostic.code);
    if (rule === undefined) continue;
    const propertyMatch =
      rule.ruleId === "column-dropped"
        ? SQL_DROP_COLUMN_PATTERN.exec(diagnostic.message)
        : SQL_RENAME_COLUMN_PATTERN.exec(diagnostic.message);
    const property = propertyMatch?.[1];
    const tableMatch = SQL_TABLE_NAME_PATTERN.exec(diagnostic.message);
    const finding: ContractCompatibilityFinding = {
      ruleId: rule.ruleId,
      classification: rule.classification,
      summary:
        rule.ruleId === "column-dropped"
          ? `${diagnostic.message} — dropping a DB column is a candidate impact for consumers`
          : `${diagnostic.message} — renames are not classified; unknown (no fabricated verdict)`,
      ...(property === undefined ? {} : { property }),
      evidence: [lineSpan(diagnostic)],
    };

    const table = tableMatch?.[1];
    const matchKey = table === undefined ? undefined : `sql SchemaContract table:${table}`;
    const host = matchKey === undefined ? undefined : byMatchKey.get(matchKey);
    if (host === undefined) {
      unattachedFindings.push(finding);
      continue;
    }
    // Çifte bulgu barındıran değerlendirmeyi yeniden kur (readonly kayıtlar).
    const merged: ContractPairEvaluation = {
      ...host,
      findings: [...host.findings, finding].sort(compareFindings),
      classification: maxClassification([...host.findings, finding]),
      changeKind: "modified",
    };
    byMatchKey.set(matchKey as string, merged);
  }

  const finalEvaluations = [...byMatchKey.values()].sort((a, b) =>
    compareStrings(a.matchKey, b.matchKey),
  );

  const reportClassification = maxClassification([
    ...finalEvaluations.flatMap((evaluation) => evaluation.findings),
    ...unattachedFindings,
  ]);

  return {
    classification: reportClassification,
    evaluations: finalEvaluations,
    unattachedFindings: [...unattachedFindings].sort(compareFindings),
  };
}
