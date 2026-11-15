//! Giriş noktası — satır-bazlı stdin/stdout JSON protokol döngüsü (M1-Rust).
//!
//! Kırmızı çizgi (proje sözleşmesi 4): stdout'ta YALNIZCA protokol
//! satırları taşınır; her log satırı stderr'e ([rust-worker] önekiyle)
//! yazılır. Girdi/çıktı BOM'suz UTF-8'dir; her yanıt tek satırdır
//! (serde_json string içi yeni satırları \n olarak kaçırır).
//!
//! Hata davranışı: bozuk JSON / doğrulama hatası → status:"error" yanıtı
//! ve döngü DEVAM EDER; yalnızca stdin/stdout'un kendisi kırılırsa süreç
//! çıkar. Çıkış kodu: 0 = normal EOF, 1 = kablo hatası.
//!
//! Stack savunması (roslyn-worker örüntüsü): StackOverflow süreci öldürür;
//! syn parse/visit derin iç içe AST'lerde stack tüketir. Ana döngü, geniş
//! stack'li ayrı bir thread'de koşar (256 MB) — derin girdi ya PARSE_ERROR
//! tanısına ya da başarıyla tamamlanmış analize dönüşür, süreç ölmez.

mod analyzer;
mod protocol;
mod sha256;

use std::io::{BufWriter, Write};

use serde_json::Value;

fn log(message: &str) {
    eprintln!("[rust-worker] {message}");
}

fn main() {
    let handle = std::thread::Builder::new()
        .stack_size(256 * 1024 * 1024)
        .spawn(run_loop)
        .expect("çalışma thread'i başlatılamadı");
    let code = handle.join().unwrap_or(1);
    std::process::exit(code);
}

fn run_loop() -> i32 {
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let stdout = std::io::stdout();
    let mut writer = BufWriter::new(stdout.lock());

    log(&format!(
        "worker başladı — protokol v{}, analyzer {} v{}",
        protocol::PROTOCOL_VERSION,
        protocol::ANALYZER_ID,
        protocol::ANALYZER_VERSION
    ));

    loop {
        match protocol::read_line_limited(&mut reader, protocol::MAX_REQUEST_LINE_BYTES) {
            Ok(Some((line, exceeded))) => {
                if exceeded {
                    // Satır sınırı aşımı: satır içerikle işlenmez; id:null +
                    // LIMIT_EXCEEDED yanıtı yazılır ve döngü devam eder.
                    let response = protocol::error_response(
                        Value::Null,
                        "LIMIT_EXCEEDED",
                        &format!(
                            "istek satırı {} bayt sınırını aştı; satır atlandı",
                            protocol::MAX_REQUEST_LINE_BYTES
                        ),
                    );
                    if !write_response(&mut writer, &response) {
                        return 1;
                    }
                    log("istek satırı sınırı aşıldı — satır atlandı");
                    continue;
                }

                if line.trim().is_empty() {
                    continue; // sessiz satır atlanır (mesaj tek satır JSON)
                }

                let response = protocol::handle_line(&line);
                if !write_response(&mut writer, &response) {
                    return 1;
                }
                log(&format!(
                    "istek işlendi: id={} status={}",
                    describe_id(response.get("id").cloned().unwrap_or(Value::Null)),
                    response
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("(yok)")
                ));
            }
            Ok(None) => break, // EOF
            Err(err) => {
                log(&format!("kablo hatası, worker sonlanıyor: {err}"));
                return 1;
            }
        }
    }

    log("stdin EOF — worker kapanıyor");
    0
}

fn write_response<W: Write>(writer: &mut W, response: &Value) -> bool {
    match serde_json::to_string(response) {
        Ok(line) => {
            if writeln!(writer, "{line}").is_err() {
                log("yanıt yazılamadı (kablo hatası)");
                return false;
            }
            if writer.flush().is_err() {
                log("yanıt flush edilemedi (kablo hatası)");
                return false;
            }
            true
        }
        Err(err) => {
            log(&format!("yanıt serileştirilemedi: {err}"));
            false
        }
    }
}

fn describe_id(id: Value) -> String {
    match id {
        Value::Null => "(yok)".to_string(),
        Value::String(s) => s,
        other => other.to_string(),
    }
}
