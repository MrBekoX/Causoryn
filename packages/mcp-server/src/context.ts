import Database from "better-sqlite3";
import { realpathSync, statSync, type Stats } from "node:fs";
import path from "node:path";

import { GraphRepositoryError, InMemoryGraphRepository } from "@causoryn/graph";
import type { GraphRepository } from "@causoryn/graph";
import { IndexJobManager, IndexService } from "@causoryn/indexing";
import { OutputAccessPolicy, WorkspaceAccessPolicy } from "@causoryn/workspace";
import {
  SqliteGraphRepository,
  SqliteWikiStore,
  WikiStoreError,
} from "@causoryn/storage-sqlite";
import { WikiSearchStore } from "@causoryn/wiki";

import {
  CausorynConfigError,
  parseCausorynServerConfig,
  type CausorynServerConfig,
} from "./config.js";

/**
 * Uygulama bağlamı: konfigürasyon → WorkspaceAccessPolicy → GraphRepository
 * → IndexService → IndexJobManager (+ isteğe bağlı otomatik ilk indeksleme)
 * → OutputAccessPolicy (sprint-3 C6/C8: export çıktı yetkilendirmesi)
 * → Wiki veri kökü (sprint-4 W5: wiki.dataDbPath beyanı → SqliteWikiStore +
 * WikiSearchStore; TŞ §16A.8 "yalnızca izinli Causoryn data-root'a yazar").
 * MCP handler'ları yalnızca bu bağlamın uygulama servis arayüzlerini tüketir;
 * parser detayı bu pakete sızmaz (wiki/architecture.md sınır 3).
 *
 * IndexJobManager (sprint-2 B6): causoryn_refresh_index'in in-process async
 * snapshot işlerini yönetir (TŞ §10.2); başlangıç autoIndex'i KAPSAMAZ —
 * o, sunucu kullanılabilirlik koşulu olarak senkron koşmaya devam eder.
 *
 * OutputAccessPolicy (sprint-3 C6): config.output.allowedOutputDirs beyanı
 * boşsa NULL'dur (default deny) — causoryn_export_documentation o durumda
 * EXPORT_NOT_ALLOWED döner, hiçbir dizine yazmaz. Beyan varsa politika
 * başlangıçta kurulur; çözümlenemeyen/bulunmayan beyanlı dizin
 * OutputPolicyError ile sunucu başlangıcını düşürür (güven kaynağı
 * kurulamıyorsa sessiz devam yoktur — WorkspaceAccessPolicy ile aynı ilke).
 *
 * Wiki veri kökü (sprint-4 W5): config.wiki.dataDbPath beyanı YOKSA
 * wikiStore/wikiSearch NULL'dur (default deny) — causoryn_wiki_build
 * PATH_DENIED ile yazamaz, wiki okuma araçları INDEX_NOT_READY döner.
 * Beyan VARSA: mutlak yol + üst dizin mevcut + allowRoot köklerinin
 * DIŞINDA doğrulanır (kaynak ağacına yazım yasak, ADR-008/TŞ §16A.8);
 * ihlal CausorynConfigError ile sunucuyu düşürür. Wiki SQLite dosyasında
 * workspace kaydı yoksa tek workspace (config.workspaceId) kaydedilir —
 * SqliteWikiStore FK sözleşmesi workspace satırı ister. Arama, WikiSearchStore
 * (W4 çekirdeği) ile AYRI salt-okunur bir SQLite bağlantısı üzerinden yürür
 * (WAL: yazan bağlantı publish'i committed görür).
 *
 * Loglar her zaman enjekte edilen logger'a gider; stdio modunda bu
 * console.error'dur (stderr) — stdout YALNIZCA MCP protokolüdür (TŞ §10.1).
 */

export interface CausorynContext {
  readonly config: CausorynServerConfig;
  readonly policy: WorkspaceAccessPolicy;
  readonly repository: GraphRepository;
  readonly indexService: IndexService;
  readonly jobManager: IndexJobManager;
  /**
   * Export çıktı yetkilendirmesi (sprint-3 C6). Beyanlı output dizini yoksa
   * null — export aracı EXPORT_NOT_ALLOWED döner (default deny).
   */
  readonly outputPolicy: OutputAccessPolicy | null;
  /**
   * Wiki projeksiyon deposu (sprint-4 W5; TŞ §16A.8). wiki.dataDbPath beyanı
   * yoksa null — wiki_build PATH_DENIED döner (default deny), wiki okuma
   * araçları INDEX_NOT_READY döner.
   */
  readonly wikiStore: SqliteWikiStore | null;
  /** Wiki FTS5 arama yüzeyi (sprint-4 W4 çekirdeği); wikiStore null ise null. */
  readonly wikiSearch: WikiSearchStore | null;
  /**
   * Saat kaynağı (domain deseni: motor saat okumaz, saat ENJEKTE edilir).
   * IndexService/jobManager ile aynı örnek; wiki_build builtAt buradan okur.
   */
  readonly clock: () => string;
  /** stderr'e yazan logger (stdio modunda console.error). */
  readonly logger: (message: string) => void;
  /**
   * Sahipliğindeki kaynakları kapatır (wiki SQLite bağlantıları). Testler
   * ve olası bir graceful-shutdown yoludur; stdio süreç çıkışında işletim
   * sistemi kalan tanıtıcıları serbest bırakır.
   */
  readonly close: () => void;
}

export interface ContextOverrides {
  readonly repository?: GraphRepository;
  readonly clock?: () => string;
  readonly logger?: (message: string) => void;
}

/**
 * Ham konfigürasyonu ayrıştırır, politikayı kurar, depoyu ve IndexService'i
 * hazırlar. `autoIndex` açık ve allowRoot doluysa ilk indeksleme koşusu
 * yapılır. Konfigürasyon geçersizse CausorynConfigError, indeksleme
 * reddiyse IndexingError fırlatır (çünkü tek workspace'in ilk indeksi
 * sunucunun kullanılabilirlik koşuludur).
 */
export function createCausorynContext(
  rawConfig: unknown,
  overrides: ContextOverrides = {},
): CausorynContext {
  const config = parseCausorynServerConfig(rawConfig);
  const policy = WorkspaceAccessPolicy.create({
    allowRoots: [...config.allowRoots],
    ignore: [...config.ignore],
    extraIgnore: [...config.extraIgnore],
    binaryExtensions: [...config.binaryExtensions],
    extensionFilterMode: config.extensionFilterMode,
    allowedExtensions: [...config.allowedExtensions],
    maxFileBytes: config.maxFileBytes,
  });
  const clock = overrides.clock ?? (() => new Date().toISOString());
  const logger =
    overrides.logger ??
    ((message: string): void => {
      console.error(message);
    });
  const repository = overrides.repository ?? new InMemoryGraphRepository();
  const indexService = new IndexService({
    workspaceId: config.workspaceId,
    policy,
    repository,
    clock,
    limits: { maxFiles: config.index.maxFiles },
  });
  // Sprint-2 B6: refresh_index işleri için yönetici; jobId per-manager
  // monoton sayaçtır (işletim kaydı — snapshot determinizmine girmez).
  const jobManager = new IndexJobManager({
    indexService,
    policy,
    clock,
  });

  // Sprint-3 C6/C8: export çıktı yetkilendirmesi — explicit beyanlı liste
  // (default [] → null politika = default deny, EXPORT_NOT_ALLOWED).
  const outputPolicy =
    config.output.allowedOutputDirs.length === 0
      ? null
      : OutputAccessPolicy.create([...config.output.allowedOutputDirs]);

  // Sprint-4 W5: wiki veri kökü — explicit beyan (default: null = default
  // deny, TŞ §16A.8 yazma sınırı).
  const wiki = openWikiStores(config, clock, logger);

  if (config.autoIndex && config.allowRoots.length > 0) {
    const run = indexService.runIndex(config.allowRoots[0] as string);
    logger(
      `index hazır: workspace=${config.workspaceId} snapshot=${run.snapshotId} files=${String(run.fileCount)} state=${run.state}`,
    );
  }

  return {
    config,
    policy,
    repository,
    indexService,
    jobManager,
    outputPolicy,
    wikiStore: wiki.store,
    wikiSearch: wiki.search,
    clock,
    logger,
    close: wiki.close,
  };
}

/**
 * wiki.dataDbPath beyanını doğrular ve (beyan varsa) SqliteWikiStore +
 * WikiSearchStore'u açar. Tamamen SENKRONDUR (context kuruluşu senkron
 * sözleşmedir). Doğrulama disiplini OutputAccessPolicy ile aynıdır: güven
 * kaynağı kurulamıyorsa sunucu başlamaz (sessiz devam yoktur).
 */
function openWikiStores(
  config: CausorynServerConfig,
  clock: () => string,
  logger: (message: string) => void,
): {
  readonly store: SqliteWikiStore | null;
  readonly search: WikiSearchStore | null;
  readonly close: () => void;
} {
  const declared = config.wiki.dataDbPath;
  if (declared === undefined) {
    return { store: null, search: null, close: (): void => {} };
  }
  const issues: string[] = [];
  if (!path.isAbsolute(declared)) {
    issues.push(`wiki.dataDbPath mutlak yol olmalı: ${declared}`);
  }
  if (declared.includes("\0")) {
    issues.push("wiki.dataDbPath null byte içeremez");
  }
  // Kaynak ağacına yazım yasağı (ADR-008 / TŞ §16A.8): beyanlı wiki
  // veritabanı allowRoot köklerinin İÇİNDE olamaz (lex + gerçek yol).
  const declaredResolved = path.resolve(declared);
  for (const root of config.allowRoots) {
    const rootResolved = path.resolve(root);
    if (
      declaredResolved === rootResolved ||
      declaredResolved.startsWith(rootResolved + path.sep)
    ) {
      issues.push(
        `wiki.dataDbPath yetkili workspace kökünün içinde olamaz (kaynak dosyalara yazım yasak, TŞ §16A.8): ${declared}`,
      );
      break;
    }
  }
  if (issues.length > 0) {
    throw new CausorynConfigError(issues);
  }
  const parentDir = path.dirname(declaredResolved);
  let parentStat: Stats;
  try {
    parentStat = statSync(parentDir);
  } catch {
    throw new CausorynConfigError([
      `wiki.dataDbPath üst dizini mevcut değil: ${parentDir} (beyanlı dizinler diskte VAR OLMALIDIR — OutputAccessPolicy disiplini)`,
    ]);
  }
  if (!parentStat.isDirectory()) {
    throw new CausorynConfigError([
      `wiki.dataDbPath üst dizini bir dizin değil: ${parentDir}`,
    ]);
  }

  // Gerçek yol sınırlaması: lex kontrolüne ek olarak kök/db üst dizini VE
  // (varsa) beyanlı SQLite DOSYASININ kendisi realpath'lenir (takım
  // denetimi bulgusu 5: dosya yolu bir sembolik bağla workspace köküne
  // işaret ediyorsa yalnızca üst-dizin denetimi yazım sızmasını KAPMAZ —
  // yeniden başlatmada dosya mevcutsa bağ dosya düzeyinde reddedilir;
  // dosya henüz yoksa denetim ilk açılışta imkânsızdır ve üst-dizin +
  // lex kontrelleri kalır).
  //
  // Güvenlik analizi bulgusu 1: (a) karşılaştırma TÜM allowRoots'a
  // uygulanır — çok köklü beyanda yalnızca allowRoots[0] ile
  // karşılaştırmak, üst dizinin allowRoots[1..] içindeki köke bağla
  // çözüldüğü kaçışı kapmaz (lex kontrolün 202-213 çok köklü karşılığı);
  // (b) realpath doğrulaması YAPILAMAZSA sessiz devam YOKTUR — güven
  // kaynağı kurulamaz, sunucu başlamaz (openWikiStores disiplini; eski
  // davranış yalnızca loglayıp devamsız denetimle başlıyordu).
  const realTargets: string[] = [];
  try {
    realTargets.push(realpathSync(parentDir));
  } catch (error) {
    throw new CausorynConfigError([
      `wiki.dataDbPath üst dizini gerçek yolu çözümlenemedi (güven kaynağı kurulamıyor; sessiz devam yoktur): ${parentDir} — ${errorText(error)}`,
    ]);
  }
  try {
    realTargets.push(realpathSync(declaredResolved));
  } catch {
    // Dosya henüz yok — üst dizin denetimi yeterli.
  }
  if (config.allowRoots.length === 0) {
    // Kök karşılaştırması imkânsızdır; eski davranışla aynı şekilde
    // (fallback kök = parentDir her zaman çakışırdı) beyan reddedilir —
    // mesaj artık gerçek nedeni söyler.
    throw new CausorynConfigError([
      `wiki.dataDbPath beyanı için yetkili workspace kökü yok (allowRoots boş): ${declared}`,
    ]);
  }
  for (const root of config.allowRoots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(path.resolve(root));
    } catch (error) {
      throw new CausorynConfigError([
        `wiki.dataDbPath doğrulanamadı — allowRoot gerçek yolu çözümlenemedi (güven kaynağı kurulamıyor; sessiz devam yoktur): ${root} — ${errorText(error)}`,
      ]);
    }
    for (const realTarget of realTargets) {
      if (
        realTarget === realRoot ||
        realTarget.startsWith(realRoot + path.sep)
      ) {
        throw new CausorynConfigError([
          `wiki.dataDbPath gerçek yolu workspace kökünün içinde (symlink kaçışı reddedildi): ${declared}`,
        ]);
      }
    }
  }

  let store: SqliteWikiStore;
  try {
    store = new SqliteWikiStore(declaredResolved);
  } catch (error) {
    const detail =
      error instanceof WikiStoreError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    throw new CausorynConfigError([`wiki.dataDbPath açılamadı: ${detail}`]);
  }

  // SqliteWikiStore FK sözleşmesi workspace satırı ister; tek workspace
  // modeli gereği config.workspaceId kaydı yoksa açılışta yazılır.
  const declaredRoot = config.allowRoots[0];
  if (declaredRoot !== undefined) {
    let graphStore: SqliteGraphRepository | undefined;
    try {
      graphStore = new SqliteGraphRepository(declaredResolved);
      graphStore.registerWorkspace({
        id: config.workspaceId,
        rootPath: declaredRoot,
        createdAt: clock(),
      });
    } catch (error) {
      if (
        error instanceof GraphRepositoryError &&
        error.code === "graph/duplicate-workspace"
      ) {
        // Zaten kayıtlı — tek workspace modeli tamam.
      } else {
        store.close();
        graphStore?.close();
        const detail = error instanceof Error ? error.message : String(error);
        throw new CausorynConfigError([
          `wiki.dataDbPath workspace kaydı yazılamadı: ${detail}`,
        ]);
      }
    } finally {
      graphStore?.close();
    }
  }

  // Arama salt-okunur ikinci bağlantı (WAL): yazan SqliteWikiStore
  // publish'ini committed düzeyde görür.
  let search: WikiSearchStore;
  let readDb: Database.Database;
  try {
    readDb = new Database(declaredResolved, { readonly: true });
    search = new WikiSearchStore(readDb);
  } catch (error) {
    store.close();
    const detail = error instanceof Error ? error.message : String(error);
    throw new CausorynConfigError([`wiki arama bağlantısı açılamadı: ${detail}`]);
  }
  logger(`wiki veri kökü hazır: ${declaredResolved}`);
  return {
    store,
    search,
    close: (): void => {
      try {
        readDb.close();
      } catch (error) {
        logger(`wiki arama bağlantısı kapatılamadı: ${errorText(error)}`);
      }
      try {
        store.close();
      } catch (error) {
        logger(`wiki veri kökü kapatılamadı: ${errorText(error)}`);
      }
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
