/**
 * Sözleşme keşfi alan tipleri — TŞ v2.1 §11, sprint-5 D1.
 *
 * Keşif adayları Unified Evidence & Knowledge Graph sözleşmesiyle hizalıdır:
 * - node adayları NODE_KINDS kataloğundaki sözleşme düğümlerine eşlenir
 *   (ApiContract / EventContract / SchemaContract; packages/domain
 *   graph-kinds.ts, TŞ §8 listesi),
 * - kenar adayları PRODUCES_CONTRACT / CONSUMES_CONTRACT türündedir ve
 *   `verified` yalnızca net isim / route / schema kimliği eşleşmesinde
 *   üretilir; isim benzerliği heuristic kalır (TŞ §11 cümlesi birebir),
 * - her aday kanıt taşır (dosya + 1 tabanlı satır aralığı).
 *
 * Keşif yüzeyi compatibility KARARI VERMEZ (backward/breaking değerlendirmesi
 * D2/D3 araçlarındadır); bu yüzden adaylarda compatibility alanı YOKTUR.
 */

export type ContractSourceKind =
  | "openapi"
  | "asyncapi"
  | "sql"
  | "json-schema"
  | "protobuf";

/** TŞ §8 node kataloğundaki sözleşme düğümü türleri. */
export type ContractNodeKind = "ApiContract" | "EventContract" | "SchemaContract";

/** Statik keşif güveni: full = sınırlı dilim içinde tam tanıma. */
export type ContractCertainty = "full" | "partial";

/** Kaynak dosya üzerindeki konum kanıtı (1 tabanlı, kapsayıcı satırlar). */
export interface ContractEvidenceSpan {
  readonly relativePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** Tek bir sözleşme alanı (tablo kolonu, schema property, proto alanı). */
export interface ContractProperty {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

/**
 * Bulunan bir sözleşmenin node adayı. `contractId` domain paketinin
 * deterministik nodeId'sidir (workspace + nodeKind + qualifiedName +
 * relativePath → sha256; aynı sözleşmenin farklı sürüm dosyaları ayrık
 * kimlik alır — drift karşılaştırmasının temeli).
 */
export interface ContractCandidate {
  readonly contractId: string;
  readonly sourceKind: ContractSourceKind;
  readonly nodeKind: ContractNodeKind;
  readonly name: string;
  readonly qualifiedName: string;
  readonly method?: string;
  readonly route?: string;
  readonly topic?: string;
  readonly channelDirection?: "publish" | "subscribe";
  readonly requestSchemaId?: string;
  readonly payloadSchemaId?: string;
  readonly responseSchemaIds: readonly string[];
  readonly properties: readonly ContractProperty[];
  readonly requiredPropertyNames: readonly string[];
  /** Yerel dosya içinde çözümlenen $ref işaretçileri (sorted, unique). */
  readonly resolvedRefs: readonly string[];
  readonly certainty: ContractCertainty;
  readonly evidence: ContractEvidenceSpan;
  /** Aday düzeyinde notlar (unknown serializer vb.; diagnostic'lardan bağımsız). */
  readonly diagnostics: readonly string[];
}

export type ServiceAnchorKind = "endpoint" | "producer" | "consumer" | "table";

/**
 * Servis tarafı ankrajı: rota kaydı / publish / subscribe / tablo erişimi.
 * D1'de `scanServiceAnchors` basitleştirilmiş satır tarayıcısıyla üretilir;
 * D2/D3'te adapter'ların Endpoint/PUBLISHES/SUBSCRIBES node'ları aynı tipi
 * besleyebilir (seam).
 *
 * Seam notu (takım denetimi bulgusu 3): TŞ §11'in "schema kimliği" verified
 * tabanı için ankrajın referans ettiği şema kimliği (schemaId) D2/D3'te bu
 * tipe eklenecektir; D1'de alan yoktur ve schema-id tabanlı kenar üretilmez.
 */
export interface ServiceAnchor {
  readonly anchorKind: ServiceAnchorKind;
  readonly symbol: string;
  readonly method?: string;
  readonly route?: string;
  readonly topic?: string;
  readonly table?: string;
  readonly evidence: ContractEvidenceSpan;
}

export type ContractEdgeKind = "PRODUCES_CONTRACT" | "CONSUMES_CONTRACT";

/**
 * Eşleşme temeli: route (net rota), topic-id (net topic kimliği),
 * name-exact (ham isim birebir) → verified kalabilir; name-similarity
 * (case/separator normalize eşitliği) ASLA verified olamaz (TŞ §11).
 */
export type ContractMatchBasis = "route" | "topic-id" | "name-exact" | "name-similarity";

/**
 * Kenar adayı. `resolution` yalnızca verified|heuristic'tir: çözülemeyen
 * eşleşme için kenar ÜRETİLMEZ (uydurma kenar yok; TŞ §8 invariant ii).
 */
export interface ContractEdgeCandidate {
  readonly edgeKind: ContractEdgeKind;
  readonly fromSymbol: string;
  readonly toContractId: string;
  readonly resolution: "verified" | "heuristic";
  readonly matchBasis: ContractMatchBasis;
  readonly evidence: readonly ContractEvidenceSpan[];
}

/** Dosya düzeyi keşif diagnostic kaydı (kenar üretmeyen/yarım kalan durumlar). */
export interface ContractDiagnostic {
  readonly relativePath: string;
  readonly code: string;
  readonly message: string;
  readonly line: number;
}

/** Bellekten gelen salt-okunur spec dosyası (fs katmanı ayrıdır). */
export interface ContractFileInput {
  readonly relativePath: string;
  readonly text: string;
}

export interface DiscoveryOutput {
  readonly contracts: readonly ContractCandidate[];
  readonly diagnostics: readonly ContractDiagnostic[];
}

export interface ContractDiscoveryResult extends DiscoveryOutput {
  readonly workspaceId: string;
  readonly analyzerId: "contracts-discovery";
  readonly analyzerVersion: "0.1.0";
}
