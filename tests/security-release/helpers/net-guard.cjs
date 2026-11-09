"use strict";
/*
 * eslint-disable gerekçesi: bu dosya NODE_OPTIONS "--require" preload kancasıdır
 * ve preload yalnızca CommonJS yükler; ESM import burada çalışmaz.
 */
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Sprint-7 F6 — network-denied davranışsal kanıt preload kancası.
 *
 * Bu dosya, bundle child süreci NODE_OPTIONS="--require <bu dosya>"
 * ile başlatıldığında TÜM modül yüklemelerinden ÖNCE çalışır ve Node'un
 * giden ağ yeteneklerini (dns/net/tls/http/https + global fetch/WebSocket)
 * KAYIT + RED davranışına çevirir:
 *
 *   - Her engellenen çağrı, CAUSORYN_NETLOG ortam değişkeniyle gösterilen
 *     dosyaya bir JSON satırı olarak yazılır (kanıt).
 *   - Ardından hata FIRLATILIR: gizli bir dış bağlantı denemesi süreci
 *     görünür şekilde düşürür; "sessiz başarılı ağ erişimi" imkânsızlaşır.
 *
 * Test sonundaki doğrulama: netlog dosyası BOŞSA oturum boyunca tek bir
 * giden ağ çağrısı denemesi bile olmamıştır (TŞ §19 "Causoryn'den hiçbir
 * AI/API/telemetry çıkışı yok" davranışsal kanıtı).
 *
 * Yalnızca test altyapısıdır; üretim bundle'ına dahil edilmez. Dosya
 * kendisi hiçbir ağ erişimi yapmaz (yalnızca yerel dosyaya append yazar).
 */

const fs = require("node:fs");

const netLogPath = process.env.CAUSORYN_NETLOG;

function deny(api) {
  if (typeof netLogPath === "string" && netLogPath.length > 0) {
    try {
      fs.appendFileSync(
        netLogPath,
        `${JSON.stringify({ api, at: new Date().toISOString() })}\n`,
        "utf8",
      );
    } catch {
      // Kanıt yazılamıyorsa bile red geçerli kalmalı.
    }
  }
  throw new Error(`CAUSORYN_NETWORK_DENIED: ${api} çağrısı reddedildi (F6 network-denied guard)`);
}

// --- dns (callback + promises API'leri) ------------------------------------
const dns = require("node:dns");
const DNS_METHODS = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCname",
  "resolveMx",
  "resolveNs",
  "resolveSrv",
  "resolveTxt",
  "reverse",
];
for (const method of DNS_METHODS) {
  if (typeof dns[method] === "function") {
    dns[method] = function deniedDnsCall() {
      return deny(`dns.${method}`);
    };
  }
  if (dns.promises && typeof dns.promises[method] === "function") {
    dns.promises[method] = function deniedDnsPromiseCall() {
      return deny(`dns.promises.${method}`);
    };
  }
}

// --- net / tls --------------------------------------------------------------
const net = require("node:net");
for (const method of ["connect", "createConnection"]) {
  if (typeof net[method] === "function") {
    net[method] = function deniedNetConnect() {
      return deny(`net.${method}`);
    };
  }
}
const tls = require("node:tls");
for (const method of ["connect", "createConnection"]) {
  if (typeof tls[method] === "function") {
    tls[method] = function deniedTlsConnect() {
      return deny(`tls.${method}`);
    };
  }
}

// --- http / https ------------------------------------------------------------
for (const moduleName of ["http", "https"]) {
  const mod = require(`node:${moduleName}`);
  for (const method of ["request", "get"]) {
    if (typeof mod[method] === "function") {
      mod[method] = function deniedHttpCall() {
        return deny(`${moduleName}.${method}`);
      };
    }
  }
}

// --- global fetch / WebSocket ------------------------------------------------
globalThis.fetch = function deniedFetch() {
  return deny("globalThis.fetch");
};
if (typeof globalThis.WebSocket !== "undefined") {
  const RealWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class DeniedWebSocket {
    constructor() {
      deny("globalThis.WebSocket");
      // deny her koşulda fırlatır; bu satır tip denetleyicisini sakinleştirir.
      throw new Error("CAUSORYN_NETWORK_DENIED: globalThis.WebSocket");
    }
  };
  void RealWebSocket;
}
