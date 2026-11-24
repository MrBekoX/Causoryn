import type { GraphNode, NodeKind, SnapshotGraph } from "@causoryn/domain";

import { GraphRepositoryError } from "./errors.js";
import type { SymbolSearchStore } from "./repository.js";
import { nodeIdentityRelativePath } from "./validation.js";

/**
 * causoryn_get_agent_context çekirdeği (Agent GPS) — TŞ v2.1 §15 (Sayfa 13);
 * §10.2 (Sayfa 10) araç girdisi "task, candidateScope?, tokenBudget"; çıktı
 * "AI Agent GPS, rationale, omissions". Sprint-3 C4.
 *
 * Sözleşme (TŞ §15): "Host modelin aktardığı görev metni yalnızca arama
 * sorgusu verisi olarak değerlendirilir. Ranking: exact symbol/route match →
 * graph proximity → contract relevance → recency → test relevance → FTS5
 * lexical match. tokenBudget yaklaşık karakter/token maliyetiyle uygulanır ve
 * estimatedTokens adıyla raporlanır; host tokenizer ile kesin eşitlik iddiası
 * yoktur. contextItems dosya yolu, dar span, reason, evidence ve omittedCount
 * sunar."
 *
 * Bu dilimin sıralı ayakları (sprint-3 C4 kapsamı; TŞ'nin "test relevance"
 * ayağı Test Intelligence dilimine aittir ve burada YOKTUR):
 *   1. exact-symbol    — birebir sembol eşleşmesi
 *   2. graph-proximity — birebir eşleşen sembolden bağlantı derinliği (BFS)
 *   3. contract        — kontrat yüzey sinyali (sprint-5 D7 ile GERÇEĞE
 *                        BAĞLANDI: girdi kaynağı (a) açık contractSymbols
 *                        ve (b) snapshot'ın sözleşme node yüzeyi — ikisinin
 *                        birleşimi; hiçbiri yoksa ayak atlanır, hata ÇIKMAZ)
 *   4. freshness       — dosya updatedAt tazeliği (sıralama ayakı; tek başına
 *                        aday ÜRETMEZ)
 *   5. fts             — symbol_fts lexical eşleşme (depo verilmezse atlanır)
 *
 * Tasarım kararları (TŞ metninin deterministik yorumu):
 * - Görev metni YALNIZCA arama verisidir: normalize edilmiş token kümesine
 *   indirilir ve çıktıya AYNEN YAZILMAZ (yalnızca queryTokens taşınır).
 *   rationale/reason alanları sabit şablonlardır; görev metni ve repo içi
 *   serbest metin hiçbir şablona interpolasyon edilmez (TŞ §15 prompt
 *   injection önlemi: repo kodundaki talimatlar sistem talimatı gibi
 *   gösterilmez).
 * - exact-symbol: görev tokenı, node'un terminal isim segmentinin
 *   camelCase/snake_case/kebab-case alt tokenlarıyla BİREBİR (case-insensitive,
 *   alt-dize eşleşmesi YOK) eşitse eşleşir. "orders" ≠ "order"; birebirlik
 *   böyledir.
 * - graph-proximity: exact seed'lerden her iki yönde bounded BFS; proximity
 *   skoru 1/(1+minDepth) (seed depth 0 → 1, depth 1 → 0.5). Keşif ayakları
 *   exact/proximity/contract/fts'tir; freshness keşif YAPMAZ, yalnızca sıralar.
 * - contract: contractSymbols kümesindeki qualifiedName'ler arasında terminal
 *   alt tokenları görev tokenlarıyla KESİŞEN node'lara 1 puan (kontrat ilgisi
 *   görevle ilişkili olmak zorundadır). Küme iki kaynaktan BİRLEŞİR:
 *   (a) çağıranın verdiği input.contractSymbols; (b) snapshot'ın SÖZLEŞME
 *   NODE YÜZEYİ (AGENT_CONTEXT_CONTRACT_NODE_KINDS türlerindeki node'ların
 *   qualifiedName'leri — D1/D2 sözleşme kayıtları grafiğe ingeste edildiğinde
 *   ayak KENDİ KENDİNİ dolar ve degradedLegs'ten çıkar; sprint-5 D7,
 *   K-013(7) sonrası). İki kaynak da boşsa ayak degradedLegs'te raporlanır,
 *   sonuç üretimine engel olmaz (degrade davranış korunur).
 * - freshness: node'un location.relativePath'i fileFreshness eşlemesinde varsa
 *   skor; distinct updatedAt değerleri leksik DESC rank'lenir ve skor
 *   (distinctCount - rank) / distinctCount olur (en yeni = 1; ISO-8601 tek tip
 *   biçim varsayımıyla leksik = kronolojik). Bu çekirdek saat OKUMAZ: mutlak
 *   "güncel/eski" yargısı yoktur, yalnızca adaylar arası göreli sıralama.
 * - fts: SymbolSearchStore (FTS5 gerçeklemesi) verilmişse görev metni depoya
 *   verilir (sorgu sözdizimi güvenliği depo sorumluluğudur); isabetler depo
 *   relevance sırasına göre 1/rank puan alır; snapshot'ta olmayan nodeId
 *   düşürülür ve rationale ile raporlanır.
 * - Sıralama: ayak sırasına göre leksik kompozit — (exact desc, proximity
 *   desc, contract desc, freshness desc, fts desc), tie-break kanonik
 *   [qualifiedName, kind, nodeId]. Erken ayak geç ayakı HER ZAMAN yener.
 * - tokenBudget: uygulanır bütçe = istek (tavan aşarsa tavana kırpılır +
 *   rationale; < 1 veya tam sayı değilse AÇIK REDDİ — 0 bütçe boş paket değil
 *   hatadır). Paket sıralı dolar: bir adayın estimatedTokens'u kalan bütçeye
 *   sığmazsa kesilir ve KALAN TÜM adaylar omittedCount'a yazılır.
 *   estimatedTokens açık formüldür: ceil(item JSON karakter sayısı / 4) —
 *   item'ın kendi estimatedTokens alanı formüle GİRMEZ; host tokenizer ile
 *   eşitlik iddiası yoktur (TŞ §15).
 * - Degrade davranış: mevcut olmayan ayaklar (contract/freshness/fts girdisi
 *   yok) atlanır ve degradedLegs listesinde {leg, reason} olarak raporlanır;
 *   asla hata fırlatmaz.
 * - Saf fonksiyon: saat okumaz, rastgelelik kullanmaz, girdi dizilerinin
 *   sırasına bağlı değildir (tüm komşuluklar ve çıktılar kanonik sıradadır).
 *   Aynı girdi iki koşumda bit-bit aynı JSON'u üretir.
 */

/** TŞ v2.1 §20 (Sayfa 22) resource budget tavanlarının GPS dilimi. */
export interface AgentContextAppliedLimits {
  /** Paket token bütçesi tavanı (estimatedTokens, chars/4). */
  readonly tokenBudget: number;
  /** graph-proximity BFS derinlik tavanı. */
  readonly maxProximityDepth: number;
}

export const AGENT_CONTEXT_LIMIT_CEILINGS: AgentContextAppliedLimits = {
  tokenBudget: 4096,
  maxProximityDepth: 4,
};

/** Verilmediğinde kullanılan varsayılanlar (tavanların altında). */
const DEFAULT_TOKEN_BUDGET = 2048;
const DEFAULT_PROXIMITY_DEPTH = 2;

/** graph-proximity BFS ayrık keşif tavanı (TŞ §20 maxNodes düzeni). */
const MAX_PROXIMITY_NODES = 250;

/** FTS arama çağrısı isabet tavanı. */
const MAX_FTS_HITS = 50;

/** Tek contextItem'ın taşıyacağı kanıt kimliği tavanı. */
const MAX_ITEM_EVIDENCE_IDS = 8;

/**
 * Sözleşme node türleri (sprint-5 D7): contract ayakının SNAPSHOT
 * kaynağı — bu türlerdeki node'ların qualifiedName'leri contractSymbols
 * kümesine BİRLEŞİR (D1/D2 sözleşme kayıtları grafiğe geldiğinde ayak
 * otomatik dolar). Küme wiki projeksiyonundaki sözleşme yüzeyiyle
 * (packages/wiki projection.ts CONTRACT_NODE_KINDS) ve compare.ts
 * API_SURFACE sözleşme alt kümesiyle aynıdır (TŞ §8 kataloğu).
 */
export const AGENT_CONTEXT_CONTRACT_NODE_KINDS: readonly NodeKind[] = [
  "ApiContract",
  "EventContract",
  "SchemaContract",
  "ContractVersion",
];

const AGENT_CONTEXT_CONTRACT_NODE_KIND_SET: ReadonlySet<string> = new Set(
  AGENT_CONTEXT_CONTRACT_NODE_KINDS,
);

/** Sıralı ayak kimlikleri; LEG_ORDER sırası = öncelik sırası. */
export type AgentContextLeg =
  | "exact-symbol"
  | "graph-proximity"
  | "contract"
  | "freshness"
  | "fts";

const LEG_ORDER: readonly AgentContextLeg[] = [
  "exact-symbol",
  "graph-proximity",
  "contract",
  "freshness",
  "fts",
];

/** Dosya tazelik kaydı: çağıran envanterden (TŞ §9 files.updatedAt) taşınır. */
export interface FileFreshness {
  readonly relativePath: string;
  readonly updatedAt: string;
}

/**
 * Agent GPS girdisi (TŞ §10.2 task/candidateScope/tokenBudget çekirdek
 * karşılığı). "candidateScope" MCP yüzey parametresi çekirdeğe henüz
 * eklenmedi: aday evresi şimdilik tüm snapshot'tır; C8 araç kaydının
 * gerekçelendirmesi beklenir (onboarding "focus" kararının aynısı).
 */
export interface AgentContextInput {
  /** Görev metni = arama sorgusu (yalnızca arama verisi; çıktıya yazılmaz). */
  readonly task: string;
  /** Paket token bütçesi (estimatedTokens, chars/4). Varsayılan 2048. */
  readonly tokenBudget?: number;
  /** graph-proximity BFS derinliği. Varsayılan 2, tavan 4. */
  readonly maxProximityDepth?: number;
  /**
   * Kontrat yüzey sembolleri (açık girdi; opsiyonel). Snapshot'ın sözleşme
   * node yüzeyiyle (AGENT_CONTEXT_CONTRACT_NODE_KINDS) BİRLEŞİR — snapshot
   * kayıtları tek başına ayak açmaya yeter (sprint-5 D7). İki kaynak da
   * boşsa ayak atlanır (degradedLegs).
   */
  readonly contractSymbols?: readonly string[];
  /** symbol_fts deposu (SQLite gerçeklemesi; yoksa ayak atlanır). */
  readonly symbolSearch?: SymbolSearchStore;
  /** Dosya updatedAt eşlemesi (yoksa freshness ayakı atlanır). */
  readonly fileFreshness?: readonly FileFreshness[];
}

/** Ayak × skor tablosu; her aday için ayak başına katkı puanı. */
export interface AgentContextScores {
  readonly exact: number;
  readonly proximity: number;
  readonly contract: number;
  readonly freshness: number;
  readonly fts: number;
}

/** Atlanan (degrade) ayak + nedeni; hata değil, raporlanan eksiklik. */
export interface DegradedLeg {
  readonly leg: AgentContextLeg;
  readonly reason: string;
}

/**
 * Tek bağlam öğesi (TŞ §15 contextItems: dosya yolu, dar span, reason,
 * evidence). estimatedTokens = ceil(item JSON karakter sayısı / 4; alanın
 * kendisi ölçüme girmez).
 */
export interface AgentContextItem {
  readonly nodeId: string;
  readonly kind: GraphNode["kind"];
  readonly qualifiedName: string;
  readonly relativePath?: string;
  /** Dar span: node'un kaynak konumu (yalnızca satır aralığı). */
  readonly span?: { readonly startLine: number; readonly endLine: number };
  /** Katkı veren ayaklar; kanonik ayak (öncelik) sırasında. */
  readonly legs: readonly AgentContextLeg[];
  readonly scores: AgentContextScores;
  /** proximity BFS derinliği (seed 0); proximity katkısı yoksa yoktur. */
  readonly proximityDepth?: number;
  /** Açıklanabilirlik: parent kenar (veya seed için temas kenarları) kanıtları. */
  readonly evidenceIds: readonly string[];
  /** Sabit şablon gerekçe (görev metni asla interpole edilmez). */
  readonly reason: string;
  readonly estimatedTokens: number;
}

/** Agent GPS sonucu: paket + muhasebe (TŞ §10.2 "rationale, omissions"). */
export interface AgentContextResult {
  readonly snapshotId: string;
  readonly snapshotState: SnapshotGraph["meta"]["state"];
  /** Normalize edilmiş (lowercase, ayrıştırılmış) distinct sorgu tokenları. */
  readonly queryTokens: readonly string[];
  /** Uygulanan (clamp sonrası) token bütçesi. */
  readonly tokenBudget: number;
  /** Paket toplam estimatedTokens: dahil item'ların toplamı (chars/4). */
  readonly estimatedTokens: number;
  readonly contextItems: readonly AgentContextItem[];
  /** Bütçe yüzünden pakete alınamayan aday sayısı. */
  readonly omittedCount: number;
  /** Bütçe öncesi toplam aday sayısı. */
  readonly candidateCount: number;
  /** Girdisi verilen ve koşan ayaklar (kanonik sıra). */
  readonly legsApplied: readonly AgentContextLeg[];
  /** Girdisi verilmediği için atlanan ayaklar + nedeni (hata değil). */
  readonly degradedLegs: readonly DegradedLeg[];
  readonly rationales: readonly string[];
}

/** Aday başına dahili birikim; çıktı tipi değil, hesap ara yapısı. */
interface Candidate {
  readonly node: GraphNode;
  readonly scores: {
    exact: number;
    proximity: number;
    contract: number;
    freshness: number;
    fts: number;
  };
  readonly legs: Set<AgentContextLeg>;
  /** proximity BFS derinliği; undefined = BFS ile ulaşilmadı. */
  depth?: number;
  /** BFS'e giren kenarın kimliği (evidence kaynağı). */
  parentEdgeId?: string;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Kanonik tie-break: [qualifiedName, kind, nodeId]. */
function compareNodeKey(a: GraphNode, b: GraphNode): number {
  if (a.qualifiedName !== b.qualifiedName) {
    return a.qualifiedName < b.qualifiedName ? -1 : 1;
  }
  if (a.kind !== b.kind) {
    return a.kind < b.kind ? -1 : 1;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}

/**
 * Görev metnini arama token kümesine indirir: harf/rakam dışı her karakter
 * ayraçtır; lowercase (toLowerCase locale'siz deterministiktir); distinct ve
 * ilk-görülme sırasında döner.
 */
function tokenizeTask(task: string): string[] {
  const parts = task.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return [...new Set(parts.filter((part) => part.length > 0))];
}

/**
 * Identifier'ı alt tokenlara böler: camelCase/PascalCase sınırı ve
 * harf/rakam dışı ayraçlar. "OrdersService" → [orders, service];
 * "getUserById" → [get, user, by, id]; "ORDER_STATUS" → [order, status].
 */
function splitIdentifierTokens(name: string): string[] {
  const spaced = name
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ");
  return spaced
    .toLowerCase()
    .split(" ")
    .filter((part) => part.length > 0);
}

/** qualifiedName'in terminal segmenti: harf/rakam/alt-tire dışına böl, sonuncu. */
function terminalIdentifier(qualifiedName: string): string {
  const parts = qualifiedName
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? qualifiedName;
}

function invalidInput(message: string): GraphRepositoryError {
  return new GraphRepositoryError("graph/agent-context-invalid-input", message);
}

/** Girdi doğrulama + clamp: uygulanacak limitleri üretir, rationale yazar. */
function resolveLimits(
  input: AgentContextInput,
  rationales: string[],
): { tokenBudget: number; maxProximityDepth: number } {
  const tokenBudget = input.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  if (
    typeof tokenBudget !== "number" ||
    !Number.isInteger(tokenBudget) ||
    tokenBudget < 1
  ) {
    throw invalidInput(
      `tokenBudget pozitif tam sayı olmalı (0 ve kesirli değerler açık reddedilir): ${String(tokenBudget)}`,
    );
  }
  const maxProximityDepth = input.maxProximityDepth ?? DEFAULT_PROXIMITY_DEPTH;
  if (
    typeof maxProximityDepth !== "number" ||
    !Number.isInteger(maxProximityDepth) ||
    maxProximityDepth < 1
  ) {
    throw invalidInput(
      `maxProximityDepth pozitif tam sayı olmalı: ${String(maxProximityDepth)}`,
    );
  }
  let appliedBudget = tokenBudget;
  let appliedDepth = maxProximityDepth;
  if (appliedBudget > AGENT_CONTEXT_LIMIT_CEILINGS.tokenBudget) {
    rationales.push(
      `tokenBudget=${String(tokenBudget)} istenen değeri tavana (${String(AGENT_CONTEXT_LIMIT_CEILINGS.tokenBudget)}) indirildi (TŞ §20 resource budget)`,
    );
    appliedBudget = AGENT_CONTEXT_LIMIT_CEILINGS.tokenBudget;
  }
  if (appliedDepth > AGENT_CONTEXT_LIMIT_CEILINGS.maxProximityDepth) {
    rationales.push(
      `maxProximityDepth=${String(maxProximityDepth)} istenen değeri tavana (${String(AGENT_CONTEXT_LIMIT_CEILINGS.maxProximityDepth)}) indirildi (TŞ §20 resource budget)`,
    );
    appliedDepth = AGENT_CONTEXT_LIMIT_CEILINGS.maxProximityDepth;
  }
  return { tokenBudget: appliedBudget, maxProximityDepth: appliedDepth };
}

/** Opsiyonel girdilerin çalışma zamanı şekil denetimi (JS çağıran koruması). */
function validateOptionalInputs(input: AgentContextInput): void {
  if (input.contractSymbols !== undefined) {
    if (!Array.isArray(input.contractSymbols)) {
      throw invalidInput("contractSymbols dizi olmalı");
    }
    for (const symbol of input.contractSymbols) {
      if (typeof symbol !== "string") {
        throw invalidInput(
          `contractSymbols öğesi string olmalı: ${String(symbol)}`,
        );
      }
    }
  }
  if (input.symbolSearch !== undefined) {
    if (
      input.symbolSearch === null ||
      typeof input.symbolSearch.searchSymbols !== "function"
    ) {
      throw invalidInput("symbolSearch SymbolSearchStore sözleşmesini uygulamalı");
    }
  }
  if (input.fileFreshness !== undefined) {
    if (!Array.isArray(input.fileFreshness)) {
      throw invalidInput("fileFreshness dizi olmalı");
    }
    for (const record of input.fileFreshness) {
      if (
        record === null ||
        typeof record !== "object" ||
        typeof record.relativePath !== "string" ||
        typeof record.updatedAt !== "string"
      ) {
        throw invalidInput(
          "fileFreshness kaydı {relativePath: string, updatedAt: string} olmalı",
        );
      }
    }
  }
}

/** BFS komşuluk girdisi: kenar kimliği + karşı uç. */
interface ProximityNeighbor {
  readonly edgeId: string;
  readonly other: string;
}

/**
 * Agent GPS bağlam paketini üretir: görev metnini arama sorgusu olarak
 * sıralı ayaklarla puanlar, bütçeye kadar paketler. Saf ve deterministiktir;
 * JSON'a serileştirilebilir.
 */
export function generateAgentContext(
  snapshot: SnapshotGraph,
  input: AgentContextInput,
): AgentContextResult {
  // 1) Girdi sözleşmesi: görev metni zorunlu ve boş olmayan arama verisidir.
  if (typeof input.task !== "string" || input.task.trim().length === 0) {
    throw invalidInput("task boş olmayan bir görev metni (arama sorgusu) olmalı");
  }
  validateOptionalInputs(input);

  // 2) Snapshot durumu: yalnızca yayımlanabilir snapshot işlenir (kardeş
  //    analyzeImpact/generateOnboarding ile aynı koruma; building okuma
  //    yollarında görünmez, failed yayın akışına girmez).
  const state = snapshot.meta.state;
  if (state !== "ready" && state !== "partial") {
    throw new GraphRepositoryError(
      "graph/agent-context-snapshot-state",
      `agent context yalnızca ready/partial snapshot üzerinde çalışır; snapshot durumu: ${String(state)}`,
    );
  }

  const rationales: string[] = [];
  const { tokenBudget, maxProximityDepth } = resolveLimits(input, rationales);
  const queryTokens = tokenizeTask(input.task);

  // 3) Ayak uygunluğu: girdisi olmayan ayaklar degrade edilir (hata değil).
  const degradedLegs: DegradedLeg[] = [];
  // contract ayakının girdisi İKİ kaynağın BİRLEŞİMİDİR (sprint-5 D7):
  // (a) açık input.contractSymbols, (b) snapshot'ın sözleşme node yüzeyi.
  // Yüzey türetimi kanoniktir: node türüne göre seçim + qualifiedName'e
  // göre sıralı-tekrarsız (girdi dizi sırasından bağımsızlık).
  const snapshotContractSymbols = [...new Set(
    snapshot.nodes
      .filter((node) => AGENT_CONTEXT_CONTRACT_NODE_KIND_SET.has(node.kind))
      .map((node) => node.qualifiedName),
  )].sort(cmp);
  const contractProvided =
    (input.contractSymbols !== undefined && input.contractSymbols.length > 0) ||
    snapshotContractSymbols.length > 0;
  const freshnessProvided =
    input.fileFreshness !== undefined && input.fileFreshness.length > 0;
  const ftsProvided = input.symbolSearch !== undefined;
  if (!contractProvided) {
    degradedLegs.push({
      leg: "contract",
      reason:
        "contract ayakı atlandı: snapshot'ta sözleşme kaydı yok (ApiContract/EventContract/SchemaContract/ContractVersion yüzeyi boş) ve contractSymbols verilmedi (hata değildir)",
    });
  }
  if (!freshnessProvided) {
    degradedLegs.push({
      leg: "freshness",
      reason:
        "freshness ayakı atlandı: fileFreshness verilmedi (dosya updatedAt eşlemesi yok)",
    });
  }
  if (!ftsProvided) {
    degradedLegs.push({
      leg: "fts",
      reason:
        "fts ayakı atlandı: symbolSearch deposu verilmedi (symbol_fts yok)",
    });
  }
  const legsApplied: AgentContextLeg[] = LEG_ORDER.filter((leg) => {
    if (leg === "contract") return contractProvided;
    if (leg === "freshness") return freshnessProvided;
    if (leg === "fts") return ftsProvided;
    return true; // exact-symbol ve graph-proximity çekirdek ayaklardır.
  });

  if (queryTokens.length === 0) {
    rationales.push(
      "görev metni arama tokenı üretmedi; boş sorgu kümesiyle hiçbir ayak eşleşemez",
    );
  }

  // 4) Node/kenar indeksleri: kanonik düzen (girdi dizi sırasından bağımsızlık).
  const nodesById = new Map<string, GraphNode>();
  for (const node of snapshot.nodes) nodesById.set(node.id, node);
  const sortedNodes = [...snapshot.nodes].sort(compareNodeKey);
  const sortedEdges = [...snapshot.edges].sort((a, b) => cmp(a.id, b.id));

  const evidenceByEdgeId = new Map<string, readonly string[]>();
  const incidentEvidence = new Map<string, string[]>();
  for (const edge of sortedEdges) {
    evidenceByEdgeId.set(edge.id, edge.evidenceIds);
    for (const endpointId of [edge.from, edge.to]) {
      const list = incidentEvidence.get(endpointId) ?? [];
      list.push(...edge.evidenceIds);
      incidentEvidence.set(endpointId, list);
    }
  }

  const candidates = new Map<string, Candidate>();
  const getCandidate = (node: GraphNode): Candidate => {
    const existing = candidates.get(node.id);
    if (existing !== undefined) return existing;
    const created: Candidate = {
      node,
      scores: { exact: 0, proximity: 0, contract: 0, freshness: 0, fts: 0 },
      legs: new Set<AgentContextLeg>(),
    };
    candidates.set(node.id, created);
    return created;
  };

  // 5) exact-symbol ayakı: görev tokenı ≡ terminal alt tokenları (birebir).
  const terminalTokensByNodeId = new Map<string, Set<string>>();
  for (const node of sortedNodes) {
    terminalTokensByNodeId.set(
      node.id,
      new Set(splitIdentifierTokens(terminalIdentifier(node.qualifiedName))),
    );
  }
  if (queryTokens.length > 0) {
    for (const node of sortedNodes) {
      const tokens = terminalTokensByNodeId.get(node.id);
      if (tokens === undefined) continue;
      let matched = 0;
      for (const token of queryTokens) {
        if (tokens.has(token)) matched += 1;
      }
      if (matched > 0) {
        const candidate = getCandidate(node);
        candidate.scores.exact = matched;
        candidate.legs.add("exact-symbol");
      }
    }
  }

  // 6) graph-proximity ayakı: exact seed'lerden her iki yönde bounded BFS.
  const adjacency = new Map<string, ProximityNeighbor[]>();
  for (const node of sortedNodes) adjacency.set(node.id, []);
  for (const edge of sortedEdges) {
    adjacency.get(edge.from)?.push({ edgeId: edge.id, other: edge.to });
    adjacency.get(edge.to)?.push({ edgeId: edge.id, other: edge.from });
  }
  for (const neighbors of adjacency.values()) {
    neighbors.sort((a, b) => cmp(a.edgeId, b.edgeId));
  }
  const seeds = sortedNodes.filter((node) => candidates.has(node.id));
  const proximityTruncated = runProximityBfs(
    seeds,
    adjacency,
    nodesById,
    maxProximityDepth,
    getCandidate,
  );
  if (proximityTruncated) {
    rationales.push(
      `graph-proximity tavanı vuruldu: ${String(MAX_PROXIMITY_NODES)} keşif node ile sınırlandı (TŞ §20 resource budget)`,
    );
  }

  // 7) contract ayakı: kontrat yüzeyinde görev tokenlarıyla kesişen semboller.
  //    Küme = açık girdi ∪ snapshot sözleşme yüzeyi (kanonik birleşim).
  if (contractProvided) {
    const contractSet = new Set<string>([
      ...(input.contractSymbols ?? []),
      ...snapshotContractSymbols,
    ]);
    if (queryTokens.length === 0) {
      rationales.push(
        "contract: boş sorgu kümesi kontrat kesişimi üretmez (ayak koştu, katkı yok)",
      );
    }
    for (const node of sortedNodes) {
      if (!contractSet.has(node.qualifiedName)) continue;
      const tokens = terminalTokensByNodeId.get(node.id);
      if (tokens === undefined) continue;
      const intersects = queryTokens.some((token) => tokens.has(token));
      if (!intersects) continue;
      const candidate = getCandidate(node);
      candidate.scores.contract = 1;
      candidate.legs.add("contract");
    }
  }

  // 8) fts ayakı: SymbolSearchStore sorgusu, depo relevance sırasıyla.
  if (ftsProvided && input.symbolSearch !== undefined) {
    if (queryTokens.length === 0) {
      rationales.push(
        "fts: boş sorgu kümesi için depo çağrısı yapılmadı (ayak koştu, katkı yok)",
      );
    } else {
      const hits = input.symbolSearch.searchSymbols(
        input.task,
        MAX_FTS_HITS,
        snapshot.meta.id,
      );
      const seen = new Set<string>();
      let rank = 0;
      let droppedUnknown = 0;
      for (const hit of hits) {
        if (seen.has(hit.nodeId)) continue;
        seen.add(hit.nodeId);
        const node = nodesById.get(hit.nodeId);
        if (node === undefined) {
          droppedUnknown += 1;
          continue;
        }
        rank += 1;
        const candidate = getCandidate(node);
        // Depo sırası relevance sırasıdır: ilk isabet en güçli (1/rank).
        if (candidate.scores.fts < 1 / rank) candidate.scores.fts = 1 / rank;
        candidate.legs.add("fts");
      }
      if (droppedUnknown > 0) {
        rationales.push(
          `fts: ${String(droppedUnknown)} isabet snapshot'ta olmayan nodeId taşıdığı için düşürüldü`,
        );
      }
    }
  }

  // 9) freshness ayakı: göreli tazelik skoru (keşif yapmaz, yalnızca sıralar).
  if (freshnessProvided && input.fileFreshness !== undefined) {
    // Aynı relativePath iki kez verildiyse leksik en büyük (en yeni) kazanır.
    const fileUpdatedAt = new Map<string, string>();
    for (const record of input.fileFreshness) {
      if (record.relativePath.length === 0 || record.updatedAt.length === 0) {
        continue; // boş kayıtlar yok sayılır (belgelenmiş davranış)
      }
      const existing = fileUpdatedAt.get(record.relativePath);
      if (existing === undefined || cmp(record.updatedAt, existing) > 0) {
        fileUpdatedAt.set(record.relativePath, record.updatedAt);
      }
    }
    // Distinct timestamp'ler leksik DESC (ISO-8601 tek tip biçim varsayımı:
    // leksik = kronolojik). Çekirdek saat okumaz; göreli sıralama yeter.
    const distinct = [...new Set(fileUpdatedAt.values())].sort(cmp).reverse();
    const scoreOfTimestamp = new Map<string, number>();
    distinct.forEach((timestamp, index) => {
      scoreOfTimestamp.set(
        timestamp,
        (distinct.length - index) / distinct.length,
      );
    });
    for (const node of sortedNodes) {
      const relativePath = nodeIdentityRelativePath(node);
      if (relativePath === undefined) continue;
      const updatedAt = fileUpdatedAt.get(relativePath);
      if (updatedAt === undefined) continue;
      const score = scoreOfTimestamp.get(updatedAt);
      if (score === undefined) continue;
      // freshness keşif yapmaz: yalnızca keşif ayaklarının açtığı adaylara
      // katkı yazar (aksi halde her taze dosya her sorguya aday olurdu).
      const candidate = candidates.get(node.id);
      if (candidate === undefined) continue;
      candidate.scores.freshness = score;
      candidate.legs.add("freshness");
    }
  }

  // 10) Sıralama: ayak sırasına göre leksik kompozit + kanonik tie-break.
  const ranked = [...candidates.values()].sort((a, b) => {
    const byScores =
      b.scores.exact - a.scores.exact ||
      b.scores.proximity - a.scores.proximity ||
      b.scores.contract - a.scores.contract ||
      b.scores.freshness - a.scores.freshness ||
      b.scores.fts - a.scores.fts;
    if (byScores !== 0) return byScores;
    return compareNodeKey(a.node, b.node);
  });

  if (ranked.length === 0) {
    rationales.push(
      `görev tokenları (${String(queryTokens.length)} adet) hiçbir ayakta aday üretmedi; boş bağlam döndürüldü`,
    );
  }

  // 11) Paketleme: bütçe sıralı dolar; ilk sığmayan adayda kesilir ve kalan
  //     adayların tamamı omittedCount'a yazılır. estimatedTokens açık formül:
  //     ceil(item JSON karakter sayısı / 4) — alanın kendisi ölçüme girmez
  //     (TŞ §15: host tokenizer ile kesin eşitlik iddiası yoktur).
  const contextItems: AgentContextItem[] = [];
  let totalEstimatedTokens = 0;
  let omittedCount = 0;
  for (const candidate of ranked) {
    const item = buildItem(candidate, evidenceByEdgeId, incidentEvidence);
    if (totalEstimatedTokens + item.estimatedTokens <= tokenBudget) {
      contextItems.push(item);
      totalEstimatedTokens += item.estimatedTokens;
    } else {
      omittedCount = ranked.length - contextItems.length;
      rationales.push(
        `tokenBudget doldu: ${String(omittedCount)} aday pakete alınmadı (uygulanan bütçe ${String(tokenBudget)})`,
      );
      break;
    }
  }

  return {
    snapshotId: snapshot.meta.id,
    snapshotState: state,
    queryTokens,
    tokenBudget,
    estimatedTokens: totalEstimatedTokens,
    contextItems,
    omittedCount,
    candidateCount: ranked.length,
    legsApplied,
    degradedLegs,
    rationales,
  };
}

/**
 * Bütçeli BFS: exact seed'lerden her iki yönde, depth ve ayrık keşif tavanlı.
 * Dönüş: keşif tavanı vurulduysa true. Komşuluklar edge.id kanonik düzeninde
 * taranır; seed'ler kanonik node sırasıyla kuyruğa girer → deterministik.
 */
function runProximityBfs(
  seeds: readonly GraphNode[],
  adjacency: ReadonlyMap<string, readonly ProximityNeighbor[]>,
  nodesById: ReadonlyMap<string, GraphNode>,
  maxDepth: number,
  getCandidate: (node: GraphNode) => Candidate,
): boolean {
  const visited = new Set<string>();
  for (const seed of seeds) {
    visited.add(seed.id);
    const candidate = getCandidate(seed);
    candidate.scores.proximity = 1; // depth 0 → 1/(1+0)
    candidate.legs.add("graph-proximity");
    candidate.depth = 0;
  }
  const queue: { id: string; depth: number; parentEdgeId: string }[] = [];
  for (const seed of seeds) {
    queue.push({ id: seed.id, depth: 0, parentEdgeId: "" });
  }
  let head = 0;
  let discovered = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    if (current === undefined) break;
    if (current.depth >= maxDepth) continue;
    for (const neighbor of adjacency.get(current.id) ?? []) {
      if (visited.has(neighbor.other)) continue;
      if (discovered >= MAX_PROXIMITY_NODES) return true;
      visited.add(neighbor.other);
      discovered += 1;
      const targetNode = nodesById.get(neighbor.other);
      if (targetNode === undefined) continue; // savunma: dangling kurucuda engelli
      const depth = current.depth + 1;
      const candidate = getCandidate(targetNode);
      candidate.scores.proximity = 1 / (1 + depth);
      candidate.legs.add("graph-proximity");
      candidate.depth = depth;
      candidate.parentEdgeId = neighbor.edgeId;
      queue.push({ id: neighbor.other, depth, parentEdgeId: neighbor.edgeId });
    }
  }
  return false;
}

/** Item inşası: alan sırası çıktı JSON determinizmini sabitler. */
function buildItem(
  candidate: Candidate,
  evidenceByEdgeId: ReadonlyMap<string, readonly string[]>,
  incidentEvidence: ReadonlyMap<string, readonly string[]>,
): AgentContextItem {
  const node = candidate.node;
  const relativePath = nodeIdentityRelativePath(node);
  const location = node.location;
  const legs: AgentContextLeg[] = LEG_ORDER.filter((leg) =>
    candidate.legs.has(leg),
  );
  const evidenceIds = resolveEvidenceIds(
    candidate,
    evidenceByEdgeId,
    incidentEvidence,
  );
  const reason = resolveReason(candidate);
  const body: Omit<AgentContextItem, "estimatedTokens"> = {
    nodeId: node.id,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    ...(relativePath === undefined ? {} : { relativePath }),
    ...(location === undefined
      ? {}
      : { span: { startLine: location.startLine, endLine: location.endLine } }),
    legs,
    scores: {
      exact: candidate.scores.exact,
      proximity: candidate.scores.proximity,
      contract: candidate.scores.contract,
      freshness: candidate.scores.freshness,
      fts: candidate.scores.fts,
    },
    ...(candidate.depth === undefined
      ? {}
      : { proximityDepth: candidate.depth }),
    evidenceIds,
    reason,
  };
  return {
    ...body,
    estimatedTokens: Math.ceil(JSON.stringify(body).length / 4),
  };
}

/**
 * Kanıt kaynağı: BFS parent kenarı; seed/pathsiz aday için temas kenarları.
 * Karar (denetim bulgusu 4): dizi BOŞ OLABİLİR ve bu meşrudur — kenarsız
 * exact seed (temas kenarı yok) veya kanıtsız heuristic/unresolved parent
 * kenar durumunda evidenceIds=[] döner. Kanıt yalnızca graph'taki gerçek
 * Evidence kayıtlarından gelir; boşluk asla uydurma kanıtla doldurulmaz
 * (kırmızı çizgi: uydurma geçiş yok). TŞ §15 contextItems'ın "evidence"
 * sunma sözleşmesi boş diziyle de sağlanır (alan mevcut, içerik gerçek);
 * boş kanıtın araç yüzeyinde ayrıca raporlanıp raporlanmayacağı C8'in
 * kesimine aittir.
 */
function resolveEvidenceIds(
  candidate: Candidate,
  evidenceByEdgeId: ReadonlyMap<string, readonly string[]>,
  incidentEvidence: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const raw =
    candidate.depth !== undefined &&
    candidate.depth >= 1 &&
    candidate.parentEdgeId !== undefined &&
    candidate.parentEdgeId.length > 0
      ? (evidenceByEdgeId.get(candidate.parentEdgeId) ?? [])
      : (incidentEvidence.get(candidate.node.id) ?? []);
  return [...new Set(raw)].sort(cmp).slice(0, MAX_ITEM_EVIDENCE_IDS);
}

/** Katkı veren en güçlü (erken) ayaka göre SABİT şablon reason. */
function resolveReason(candidate: Candidate): string {
  for (const leg of LEG_ORDER) {
    if (!candidate.legs.has(leg)) continue;
    switch (leg) {
      case "exact-symbol":
        return "exact-symbol: görev tokenları sembol adı tokenlarıyla birebir eşleşti";
      case "graph-proximity": {
        const depth = candidate.depth ?? 0;
        return `graph-proximity: birebir eşleşen sembolden ${String(depth)} kenar derinliğinde bağlı`;
      }
      case "contract":
        return "contract: görevle token kesişen kontrat yüzey sembolü";
      case "freshness":
        return "freshness: dosya tazeliğine göre sıralandı";
      case "fts":
        return "fts: symbol_fts eşleşmesi";
    }
  }
  // Ulaşılamaz: aday en az bir ayakla oluşur.
  return "agent-context: yapısal aday";
}
