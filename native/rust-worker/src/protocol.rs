//! stdin/stdout satır-bazlı JSON protokol sözleşmesi — PROTOCOL.md v1.
//!
//! Kırmızı çizgi (proje sözleşmesi 4): stdout'ta YALNIZCA protokol
//! satırları taşınır; tüm loglar stderr'e ([rust-worker] önekiyle)
//! yazılır. JSON serileştirmesi tek satır üretir (serde_json string içi
//! yeni satırları \n olarak kaçırır) — framing bozulmaz.
//!
//! Hata kodları yalnızca TŞ §10.1 + K-008 kümesinden: INVALID_ARGUMENT,
//! INTERNAL_ERROR, LIMIT_EXCEEDED. Worker kendi hata kodu icat etmez.
//! İstek düzeyi sorunlar tüm isteği reddeder; döngü DEVAM EDER.

use std::collections::BTreeSet;
use std::io::BufRead;

use serde_json::{json, Value};

use crate::analyzer::{self, FileEntry};

pub const PROTOCOL_VERSION: &str = "1";
pub const ANALYZER_ID: &str = "rust-worker";
pub const ANALYZER_VERSION: &str = "0.1.0";
/// TŞ §7 route katmanı beyanı — capabilities.routeDetection alanına yazılır.
pub const ROUTE_DETECTION: &str = "rust-attribute-macro-route-pattern";

/// Kaynak sınırları (TŞ §9 resource budget; K-010: yalnızca boyut limitleri).
pub const MAX_REQUEST_LINE_BYTES: usize = 64_000_000;
pub const MAX_FILE_COUNT: usize = 5_000;
pub const MAX_FILE_CONTENT_BYTES: usize = 2_000_000;

pub struct ProtocolError {
    pub code: &'static str,
    pub message: String,
}

fn invalid(message: String) -> ProtocolError {
    ProtocolError {
        code: "INVALID_ARGUMENT",
        message,
    }
}

fn limit_exceeded(message: String) -> ProtocolError {
    ProtocolError {
        code: "LIMIT_EXCEEDED",
        message,
    }
}

/// Hata yanıtı üretir; id verilen değerle echo edilir (null olabilir).
pub fn error_response(id: Value, code: &str, message: &str) -> Value {
    json!({
        "id": id,
        "protocolVersion": PROTOCOL_VERSION,
        "status": "error",
        "error": { "code": code, "message": message },
    })
}

/// Bozuk satırlarda bile echo yapılabilecek 'id' alanını kurtarır.
pub fn extract_id(line: &str) -> Value {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| value.get("id").cloned())
        .unwrap_or(Value::Null)
}

/// Tek satır isteği işler; her sonuç TAM BİR yanıt Value'sudur.
pub fn handle_line(line: &str) -> Value {
    match process_request(line) {
        Ok(response) => response,
        Err(err) => error_response(extract_id(line), err.code, &err.message),
    }
}

/// Boyut sınırlı satır okuyucu (roslyn LimitedLineReader karşılığı):
/// satır sınırı aşılırsa satır DISCARD edilir ve exceeded=true döner;
/// '\r' atlanır (CRLF tolere; JSON string içindeki CR zaten \r kaçışlıdır).
/// EOF'ta newline'sız kalıntı son satır olarak döner.
pub fn read_line_limited(
    reader: &mut impl BufRead,
    max_bytes: usize,
) -> std::io::Result<Option<(String, bool)>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut discarding = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if discarding {
                return Ok(Some((String::new(), true)));
            }
            if buf.is_empty() {
                return Ok(None);
            }
            return Ok(Some((String::from_utf8_lossy(&buf).into_owned(), false)));
        }
        let mut consumed = 0usize;
        let mut hit_newline = false;
        for &byte in available {
            consumed += 1;
            if byte == b'\n' {
                hit_newline = true;
                break;
            }
            if byte == b'\r' {
                continue;
            }
            if !discarding {
                buf.push(byte);
                if buf.len() > max_bytes {
                    discarding = true;
                    buf.clear();
                }
            }
        }
        reader.consume(consumed);
        if hit_newline {
            if discarding {
                return Ok(Some((String::new(), true)));
            }
            return Ok(Some((String::from_utf8_lossy(&buf).into_owned(), false)));
        }
    }
}

fn validate_path(path: &str) -> Result<(), ProtocolError> {
    if path.starts_with('/')
        || (path.len() >= 2
            && path.as_bytes()[1] == b':'
            && path.as_bytes()[0].is_ascii_alphabetic())
    {
        return Err(invalid(format!(
            "Mutlak kaynak yolu kabul edilmez: {path}"
        )));
    }

    for segment in path.split('/') {
        if segment.is_empty() || segment == "." {
            return Err(invalid(format!(
                "Kaynak yolu boş/geçersiz segment içeriyor: {path}"
            )));
        }
        if segment == ".." {
            return Err(invalid(format!(
                "Kaynak yolu kök dışına çıkıyor: {path}"
            )));
        }
    }

    Ok(())
}

fn process_request(line: &str) -> Result<Value, ProtocolError> {
    let value: Value = serde_json::from_str(line)
        .map_err(|e| invalid(format!("istek JSON'u ayrıştırılamadı: {e}")))?;
    let obj = value
        .as_object()
        .ok_or_else(|| invalid("istek JSON'u bir nesne olmalı".to_string()))?;

    let id = obj
        .get("id")
        .ok_or_else(|| invalid("id zorunludur".to_string()))?;
    if !id.is_string() && !id.is_number() {
        return Err(invalid("id string ya da sayı olmalıdır".to_string()));
    }
    let id = id.clone();

    // Kesin şema reddi (Zod strictObject disipliniyle aynı).
    for key in obj.keys() {
        if !matches!(key.as_str(), "id" | "type" | "protocolVersion" | "files") {
            return Err(invalid(format!("bilinmeyen üst-düzey alan: '{key}'")));
        }
    }

    let typ = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("type zorunludur".to_string()))?;
    if typ != "analyze" {
        return Err(invalid(format!(
            "bilinmeyen istek türü: '{typ}' (desteklenen: 'analyze')"
        )));
    }

    if let Some(pv) = obj.get("protocolVersion") {
        if pv.as_str() != Some(PROTOCOL_VERSION) {
            return Err(invalid(format!(
                "desteklenmeyen protocolVersion: {pv} (desteklenen: '{PROTOCOL_VERSION}')"
            )));
        }
    }

    let files = obj
        .get("files")
        .ok_or_else(|| invalid("files zorunludur".to_string()))?;
    let arr = files
        .as_array()
        .ok_or_else(|| invalid("files bir dizi olmalıdır".to_string()))?;
    if arr.is_empty() {
        return Err(invalid("files en az 1 dosya içermelidir".to_string()));
    }
    if arr.len() > MAX_FILE_COUNT {
        return Err(limit_exceeded(format!(
            "dosya sayısı sınırı aşıldı: {} > {}",
            arr.len(),
            MAX_FILE_COUNT
        )));
    }

    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut entries: Vec<FileEntry> = Vec::with_capacity(arr.len());
    for file in arr {
        let fobj = file
            .as_object()
            .ok_or_else(|| invalid("files[] girdisi nesne olmalıdır".to_string()))?;
        for key in fobj.keys() {
            if !matches!(key.as_str(), "path" | "content") {
                return Err(invalid(format!("files[] bilinmeyen alan: '{key}'")));
            }
        }
        let path = fobj
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("files[].path string olmalıdır".to_string()))?;
        let content = fobj
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("files[].content string olmalıdır".to_string()))?;

        validate_path(path)?;
        if !seen.insert(path.to_string()) {
            return Err(invalid(format!(
                "aynı kaynak yolu iki kez verildi: {path}"
            )));
        }
        if content.len() > MAX_FILE_CONTENT_BYTES {
            return Err(limit_exceeded(format!(
                "dosya içerik sınırı aşıldı: {} bayt > {} bayt ({})",
                content.len(),
                MAX_FILE_CONTENT_BYTES,
                path
            )));
        }

        entries.push(FileEntry {
            path: path.to_string(),
            content: content.to_string(),
        });
    }

    // Determinizm (TŞ §8 invariant iv/vi): kaynaklar relativePath'e göre
    // sıralanır; analiz çıktısı kanonik anahtarla sıralanır.
    entries.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(analyzer::analyze(&id, &entries))
}
