//! syn 2 tabanlı deterministik analiz — M1-Rust.
//!
//! Çıkarım sözleşmesi (native/rust-worker/PROTOCOL.md v1):
//! - Bildirimler: fn → Function, struct/enum → Class, trait → Interface,
//!   impl fn → Method (CONTAINS File→tip, tip→Method).
//! - CALLS resolution üçlüsü:
//!     * aynı modülde tanımlı fn'e doğrudan (bare) çağrı → verified,
//!     * nitelikli yol çağrısı (a::B::c / B::c) → son 2 segment eşleşmesi
//!       modül öneklerini ve `use` import'larını doğrulamadığından
//!       heuristic + explicit ambiguity ("unverified-module-prefix-suffix-match"),
//!       çok eşleşme → heuristic + çoklu aday ambiguity, hiç eşleşme yok →
//!       unresolved + UnknownExternal,
//!     * metot çağrısı (x.foo()) → alıcı türü çözülmez (trait dispatch
//!       bu dilimde yok) → heuristic; tek isim tablosu adayı hedef,
//!       çok aday → ambiguity, aday yok → unresolved.
//!   verified/heuristic kenarlar "semantic-symbol", unresolved kenarlar ve
//!   CONTAINS "ast-span", ROUTES_TO "route-attribute" kanıt türünü taşır
//!   (kanıt türleri TŞ §8 kümesinden; rationale metni isim tablosu
//!   dayanağını DÜRÜST belirtir — semantik çözümleyici yoktur).
//! - Route tespiti: #[get/post/put/delete/patch/head/options/connect/trace("…")]
//!   ve #[route("…", method = …)] (axum/actix/rocket örüntüleri) → Endpoint
//!   node + ROUTES_TO (verified, sözdizimsel bağ).
//! - Determinizm: BTreeMap/BTreeSet, kanonik sıralama, saat okunmaz.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};
use syn::spanned::Spanned;
use syn::visit::Visit;
use syn::{Attribute, Expr, Item, Lit};

use crate::protocol::{ANALYZER_ID, ANALYZER_VERSION, MAX_RESPONSE_NODES, ROUTE_DETECTION};
use crate::sha256::sha256_hex;

pub struct FileEntry {
    pub path: String,
    pub content: String,
}

pub struct Diagnostic {
    pub relative_path: String,
    pub code: String,
    pub message: String,
    pub line: usize,
}

/// Node kimliği (domain NodeRef karşılığı; rel_path boşsa relativePath yok).
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct NodeKey {
    kind: &'static str,
    qualified: String,
    rel_path: String,
}

impl NodeKey {
    fn with_path(kind: &'static str, qualified: String, rel_path: &str) -> Self {
        NodeKey {
            kind,
            qualified,
            rel_path: rel_path.to_string(),
        }
    }

    fn virtual_(kind: &'static str, qualified: String) -> Self {
        NodeKey {
            kind,
            qualified,
            rel_path: String::new(),
        }
    }
}

#[derive(Clone)]
struct EdgeRec {
    kind: &'static str,
    from: NodeKey,
    to: NodeKey,
    resolution: &'static str,
    evidence: Vec<Value>,
    ambiguity: Option<Value>,
}

/// Kenar birleştirme anahtarı — (kind, from, to, resolution) dörtlüsü.
/// Aynı anahtarlı kenarlar tek EdgeRec'te birleşir; kanonik çıktı sırası
/// da bu anahtarla kurulur (analyze sonundaki sıralama ile aynı alanlar).
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct EdgeKey {
    kind: &'static str,
    from: NodeKey,
    to: NodeKey,
    resolution: &'static str,
}

/// Bu dilimde modellenmeyen yapılar — TŞ §7 unsupportedConstructs beyanı.
const UNSUPPORTED_CONSTRUCTS: [&str; 6] = [
    // Metot çağrısının alıcı türü çözülmez: trait metodu hangi implementasyon
    // üzerinde koşar, sorusu bu dilimde cevaplanmaz (isim tablosu adayları
    // heuristic + ambiguity ile raporlanır).
    "trait-method-dispatch",
    // Makro gövdeleri gezilmez (println!, vec! vb. ürettikleri kod analiz
    // edilmez); makro ile tanımlı üst-düzey öğeler atlanır.
    "macro-defined-items",
    // `use` import'ları IMPORTS kenarı üretmez ve çözümlenmez.
    "use-import-resolution",
    // Analiz seti dışındaki crate sembolleri çözülmez (UnknownExternal).
    "cross-crate-symbol-resolution",
    // Fonksiyon İÇİ nested fn/trait/impl öğelerinin gövdeleri gezilmez.
    "nested-fn-items",
    // struct literal (Order { .. }) REFERENCES kenarı üretmez.
    "struct-literal-references",
];

#[derive(Default)]
struct Tables {
    nodes: BTreeMap<NodeKey, Value>,
    /// Aynı dosya (modül) içindeki serbest fn: ident → node anahtarı.
    free_fn_by_file: Vec<(String, BTreeMap<String, NodeKey>)>,
    /// (modül son segmenti, fn adı) → adaylar (nitelikli yol çağrısı için).
    free_fn_global: BTreeMap<(String, String), Vec<NodeKey>>,
    /// Bare fn adı → adaylar (import kanıtı olmayan çapraz dosya eşleşmesi).
    free_fn_bare: BTreeMap<String, Vec<NodeKey>>,
    /// (ebeveyn tip adı, metot adı) → adaylar.
    methods: BTreeMap<(String, String), Vec<NodeKey>>,
    /// Bare metot adı → adaylar (metot çağrısı çözümü).
    methods_bare: BTreeMap<String, Vec<NodeKey>>,
    /// Bildirilen tipler: tip adı → node anahtarı (impl bağlama için).
    declared_types: BTreeMap<String, NodeKey>,
    edges: Vec<EdgeRec>,
    /// EdgeKey → edges dizin konumu. push_edge'in her yeni kenarda tüm
    /// edges dizisini doğrusal taraması (O(E²)) yerine BTreeMap araması
    /// (O(E log E)) — sembol-yoğun girdide tek istek başına CPU savunması.
    edge_index: BTreeMap<EdgeKey, usize>,
    evidence_seen: BTreeSet<String>,
    evidence: Vec<Value>,
    diagnostics: Vec<Diagnostic>,
}

fn span_lines<T: Spanned>(item: &T) -> (usize, usize) {
    let span = item.span();
    let start = span.start().line.max(1);
    let end = span.end().line.max(start);
    (start, end)
}

fn node_value(key: &NodeKey, attributes: Value) -> Value {
    let mut value = json!({
        "kind": key.kind,
        "qualifiedName": key.qualified,
        "language": "rust",
        "attributes": attributes,
    });
    if !key.rel_path.is_empty() {
        value["relativePath"] = Value::String(key.rel_path.clone());
    }
    value
}

fn insert_node(tables: &mut Tables, key: NodeKey, attributes: Value) -> NodeKey {
    tables
        .nodes
        .entry(key.clone())
        .or_insert_with(|| node_value(&key, attributes));
    key
}

fn push_evidence(
    tables: &mut Tables,
    kind: &str,
    rel_path: &str,
    start_line: usize,
    end_line: usize,
    source_hash: &str,
    rationale: String,
) -> Value {
    let evidence = json!({
        "kind": kind,
        "span": {
            "relativePath": rel_path,
            "startLine": start_line,
            "endLine": end_line,
            "sourceHash": source_hash,
        },
        "analyzerId": ANALYZER_ID,
        "analyzerVersion": ANALYZER_VERSION,
        "rationale": rationale,
    });
    let key = serde_json::to_string(&evidence).unwrap_or_default();
    if tables.evidence_seen.insert(key) {
        tables.evidence.push(evidence.clone());
    }
    evidence
}

#[allow(clippy::too_many_arguments)]
fn push_edge(
    tables: &mut Tables,
    kind: &'static str,
    from: NodeKey,
    to: NodeKey,
    resolution: &'static str,
    evidence: Value,
    ambiguity: Option<Value>,
) {
    // Birleştirme araması BTreeMap indeksiyle: doğrusal tarama yok.
    let key = EdgeKey {
        kind,
        from: from.clone(),
        to: to.clone(),
        resolution,
    };
    if let Some(&index) = tables.edge_index.get(&key) {
        let existing = &mut tables.edges[index];
        if !existing.evidence.contains(&evidence) {
            existing.evidence.push(evidence);
            existing.evidence.sort_by(|a, b| {
                let key_a = serde_json::to_string(a).unwrap_or_default();
                let key_b = serde_json::to_string(b).unwrap_or_default();
                key_a.cmp(&key_b)
            });
        }
        return;
    }
    tables.edge_index.insert(key, tables.edges.len());
    tables.edges.push(EdgeRec {
        kind,
        from,
        to,
        resolution,
        evidence: vec![evidence],
        ambiguity,
    });
}

/// relativePath → modül yolu (belgeli kural: "src/" öneki atılır; son
/// segment main/lib/mod atılır; kalan boşsa "crate").
fn module_path_of(rel_path: &str) -> String {
    let trimmed = rel_path.strip_suffix(".rs").unwrap_or(rel_path);
    let mut segments: Vec<&str> = trimmed
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if segments.first() == Some(&"src") {
        segments.remove(0);
    }
    if let Some(last) = segments.last() {
        if *last == "main" || *last == "lib" || *last == "mod" {
            segments.pop();
        }
    }
    if segments.is_empty() {
        "crate".to_string()
    } else {
        format!("crate::{}", segments.join("::"))
    }
}

const ROUTE_VERBS: [&str; 9] = [
    "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "CONNECT", "TRACE",
];

fn expr_to_method(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Lit(lit) => match &lit.lit {
            Lit::Str(s) => Some(s.value().to_ascii_uppercase()),
            _ => None,
        },
        Expr::Path(path) => path
            .path
            .segments
            .last()
            .map(|segment| segment.ident.to_string().to_ascii_uppercase()),
        _ => None,
    }
}

/// #[get("/orders")] / #[route("/orders", method = "GET")] / axum tarzı
/// #[route("/orders", method(GET))] ayrıştırması. Return: (method, path).
fn parse_route_attr(attr: &Attribute) -> Option<(String, String)> {
    let ident = attr
        .path()
        .segments
        .last()
        .map(|segment| segment.ident.to_string().to_ascii_uppercase())?;

    let mut method: Option<String> = None;
    if ROUTE_VERBS.contains(&ident.as_str()) {
        method = Some(ident);
    } else if ident != "ROUTE" {
        return None;
    }

    let exprs = attr
        .parse_args_with(
            syn::punctuated::Punctuated::<Expr, syn::token::Comma>::parse_terminated,
        )
        .ok()?;

    let mut path: Option<String> = None;
    let mut arg_method: Option<String> = None;
    for expr in exprs {
        match expr {
            Expr::Lit(lit) => {
                if let Lit::Str(s) = &lit.lit {
                    if path.is_none() {
                        path = Some(s.value());
                    }
                }
            }
            Expr::Assign(assign) => {
                let is_method_name = matches!(
                    &*assign.left,
                    Expr::Path(p)
                        if p.path
                            .segments
                            .last()
                            .map(|segment| segment.ident == "method")
                            .unwrap_or(false)
                );
                if is_method_name {
                    arg_method = expr_to_method(&assign.right);
                }
            }
            Expr::Call(call) => {
                let is_method_name = matches!(
                    &*call.func,
                    Expr::Path(p)
                        if p.path
                            .segments
                            .last()
                            .map(|segment| segment.ident == "method")
                            .unwrap_or(false)
                );
                if is_method_name {
                    for arg in &call.args {
                        if let Some(m) = expr_to_method(arg) {
                            arg_method = Some(m);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if arg_method.is_some() {
        method = arg_method;
    }
    let method = method?;
    let path = path?;
    let normalized_path = if path.starts_with('/') {
        path
    } else {
        format!("/{path}")
    };
    Some((method, normalized_path))
}

struct CallVisitor<'a> {
    rel_path: &'a str,
    source_hash: &'a str,
    tables: &'a mut Tables,
    caller: NodeKey,
}

impl<'a> CallVisitor<'a> {
    fn resolve_candidates(&mut self, mut candidates: Vec<NodeKey>) -> Vec<NodeKey> {
        candidates.sort();
        candidates.dedup();
        candidates
    }

    fn emit_call_edge(
        &mut self,
        target: NodeKey,
        resolution: &'static str,
        start_line: usize,
        end_line: usize,
        rationale: String,
        ambiguity: Option<Value>,
    ) {
        let evidence = push_evidence(
            self.tables,
            if resolution == "unresolved" {
                "ast-span"
            } else {
                "semantic-symbol"
            },
            self.rel_path,
            start_line,
            end_line,
            self.source_hash,
            rationale,
        );
        push_edge(
            self.tables,
            "CALLS",
            self.caller.clone(),
            target,
            resolution,
            evidence,
            ambiguity,
        );
    }

    /// Çözülemeyen çağrı: UnknownExternal node'u (varsa) ve unresolved
    /// kenar üretir — UYDURMA hedef üretilmez.
    fn emit_unresolved(
        &mut self,
        qualified_name: String,
        call_text: &str,
        start_line: usize,
        end_line: usize,
    ) {
        let target = insert_node(
            self.tables,
            NodeKey::virtual_("UnknownExternal", qualified_name),
            json!({}),
        );
        let rationale = format!(
            "CALLS: '{call_text}' çağrısı analiz setinde hiçbir sembolle eşleşmedi (unresolved); hedef UnknownExternal — uydurma sembol üretilmez."
        );
        self.emit_call_edge(
            target,
            "unresolved",
            start_line,
            end_line,
            rationale,
            None,
        );
    }

    fn resolve_path_call(&mut self, idents: &[String], start_line: usize, end_line: usize) {
        let call_text = idents.join("::");
        if idents.len() == 1 {
            let name = &idents[0];
            // 1) Aynı modülde doğrudan çağrı → verified (ask sözleşmesi).
            if let Some((_, file_fns)) = self
                .tables
                .free_fn_by_file
                .iter()
                .find(|(module, _)| *module == self.caller_module_of())
            {
                if let Some(target) = file_fns.get(name) {
                    let target = target.clone();
                    let rationale = format!(
                        "CALLS: '{name}' doğrudan çağrısı aynı modülde tanımlı '{t}' sembolüne çözümlendi (verified; syn AST, semantik çözümleyici yoktur).",
                        t = target.qualified
                    );
                    self.emit_call_edge(target, "verified", start_line, end_line, rationale, None);
                    return;
                }
            }
            // 2) Başka dosyada tek aday → heuristic (import kanıtı yok).
            let candidates =
                self.resolve_candidates(self.tables.free_fn_bare.get(name).cloned().unwrap_or_default());
            match candidates.len() {
                0 => self.emit_unresolved(name.clone(), &call_text, start_line, end_line),
                1 => {
                    let target = candidates[0].clone();
                    let rationale = format!(
                        "CALLS: '{name}' çağrısı import kanıtı olmadan isim tablosunda tek eşleşme '{t}' buldu (heuristic; modül/import doğrulaması bu dilimde yoktur).",
                        t = target.qualified
                    );
                    self.emit_call_edge(target, "heuristic", start_line, end_line, rationale, None);
                }
                _ => {
                    let candidates_names: Vec<String> =
                        candidates.iter().map(|c| c.qualified.clone()).collect();
                    let target = candidates[0].clone();
                    let rationale = format!(
                        "CALLS: '{name}' çağrısı isim tablosunda birden çok eşleşme buldu (heuristic + ambiguity)."
                    );
                    let ambiguity = json!({
                        "candidates": candidates_names,
                        "reason": format!("'{name}' adı analiz setinde birden çok serbest fn ile eşleşiyor; alıcı/modül kanıtı yok"),
                    });
                    self.emit_call_edge(
                        target,
                        "heuristic",
                        start_line,
                        end_line,
                        rationale,
                        Some(ambiguity),
                    );
                }
            }
            return;
        }

        // Nitelikli yol çağrısı: son iki segment (tip/modül, isim).
        let type_name = &idents[idents.len() - 2];
        let name = &idents[idents.len() - 1];
        let mut candidates: Vec<NodeKey> = Vec::new();
        if let Some(list) = self.tables.methods.get(&(type_name.clone(), name.clone())) {
            candidates.extend(list.iter().cloned());
        }
        if let Some(list) = self
            .tables
            .free_fn_global
            .get(&(type_name.clone(), name.clone()))
        {
            candidates.extend(list.iter().cloned());
        }
        let candidates = self.resolve_candidates(candidates);
        match candidates.len() {
            0 => self.emit_unresolved(call_text.clone(), &call_text, start_line, end_line),
            1 => {
                let target = candidates[0].clone();
                let rationale = format!(
                    "CALLS: nitelikli yol çağrısı '{call_text}' → '{t}' son 2 segment ('{type_name}::{name}') ile eşleşti; modül önekleri ve use import'ları doğrulanmadığından heuristic işaretlendi (unverified-module-prefix-suffix-match).",
                    t = target.qualified
                );
                let ambiguity = json!({
                    "candidates": [target.qualified.clone()],
                    "reason": format!(
                        "unverified-module-prefix-suffix-match: '{call_text}' → '{t}' yalnızca son 2 segment ('{type_name}::{name}') eşleşmesine dayanır; modül önekleri ve use import'ları doğrulanmadı",
                        t = target.qualified
                    ),
                });
                self.emit_call_edge(
                    target,
                    "heuristic",
                    start_line,
                    end_line,
                    rationale,
                    Some(ambiguity),
                );
            }
            _ => {
                let candidates_names: Vec<String> =
                    candidates.iter().map(|c| c.qualified.clone()).collect();
                let target = candidates[0].clone();
                let rationale = format!(
                    "CALLS: nitelikli yol çağrısı '{call_text}' isim tablosunda birden çok eşleşme buldu (heuristic + ambiguity)."
                );
                let ambiguity = json!({
                    "candidates": candidates_names,
                    "reason": format!("'{type_name}::{name}' analiz setinde birden çok sembolle eşleşiyor"),
                });
                self.emit_call_edge(
                    target,
                    "heuristic",
                    start_line,
                    end_line,
                    rationale,
                    Some(ambiguity),
                );
            }
        }
    }

    fn resolve_method_call(&mut self, name: &str, start_line: usize, end_line: usize) {
        let candidates =
            self.resolve_candidates(self.tables.methods_bare.get(name).cloned().unwrap_or_default());
        match candidates.len() {
            0 => self.emit_unresolved(name.to_string(), name, start_line, end_line),
            1 => {
                let target = candidates[0].clone();
                let rationale = format!(
                    "CALLS: metot çağrısı '{name}' — alıcı türü çözülemedi (trait dispatch bu dilimde çözülmez); isim tablosu eşleşmesi '{t}' (heuristic).",
                    t = target.qualified
                );
                self.emit_call_edge(target, "heuristic", start_line, end_line, rationale, None);
            }
            _ => {
                let candidates_names: Vec<String> =
                    candidates.iter().map(|c| c.qualified.clone()).collect();
                let target = candidates[0].clone();
                let rationale = format!(
                    "CALLS: metot çağrısı '{name}' birden çok aday buldu — trait/implementasyon ayrımı çözülemedi (heuristic + ambiguity)."
                );
                let ambiguity = json!({
                    "candidates": candidates_names,
                    "reason": format!("'{name}' adında birden çok trait/implementasyon metodu var; alıcı türü bilinmiyor"),
                });
                self.emit_call_edge(
                    target,
                    "heuristic",
                    start_line,
                    end_line,
                    rationale,
                    Some(ambiguity),
                );
            }
        }
    }

    fn caller_module_of(&self) -> String {
        // Caller qname "crate::..::fn" biçimindedir; dosya modül yolunu
        // rel_path'ten türet (tek doğruluk kaynağı dosya modülüdür).
        module_path_of(self.rel_path)
    }
}

impl<'a> Visit<'a> for CallVisitor<'a> {
    // Fonksiyon İÇİ nested öğeler gezilmez (belgeli unsupported).
    fn visit_item(&mut self, _item: &'a Item) {}

    fn visit_expr_call(&mut self, call: &'a syn::ExprCall) {
        let (start_line, end_line) = span_lines(call);
        match &*call.func {
            Expr::Path(path) => {
                let idents: Vec<String> = path
                    .path
                    .segments
                    .iter()
                    .map(|segment| segment.ident.to_string())
                    .collect();
                self.resolve_path_call(&idents, start_line, end_line);
            }
            _ => {
                self.emit_unresolved(
                    "(anonim-cağrı)".to_string(),
                    "(anonim-cağrı)",
                    start_line,
                    end_line,
                );
            }
        }
        // Argümanların İÇİNDEKİ çağrılar da taranmalı (f(g()), closure'lar).
        syn::visit::visit_expr_call(self, call);
    }

    fn visit_expr_method_call(&mut self, call: &'a syn::ExprMethodCall) {
        let (start_line, end_line) = span_lines(call);
        let name = call.method.to_string();
        self.resolve_method_call(&name, start_line, end_line);
        // Alıcı zincirleri ve argümanlar (a.b().c()) taranmalı.
        syn::visit::visit_expr_method_call(self, call);
    }
}

fn emit_route(
    tables: &mut Tables,
    attr: &Attribute,
    target: &NodeKey,
    rel_path: &str,
    source_hash: &str,
) -> bool {
    if let Some((method, path)) = parse_route_attr(attr) {
        let endpoint_key = insert_node(
            tables,
            NodeKey::virtual_("Endpoint", format!("{method} {path}")),
            json!({ "method": method, "path": path }),
        );
        let (start_line, end_line) = span_lines(attr);
        let evidence = push_evidence(
            tables,
            "route-attribute",
            rel_path,
            start_line,
            end_line,
            source_hash,
            format!(
                "ROUTES_TO: #[{attr_path}] özniteliği '{target}' öğesine sözdizimsel olarak bağlı (route-attribute; verified; syn AST).",
                attr_path = format!("{method} \"{path}\"").to_lowercase(),
                target = target.qualified
            ),
        );
        push_edge(
            tables,
            "ROUTES_TO",
            endpoint_key,
            target.clone(),
            "verified",
            evidence,
            None,
        );
        return true;
    }
    false
}

fn join_q(module: &str, name: &str) -> String {
    format!("{module}::{name}")
}

/// Tek dosyanın bildirim geçişi: node'lar + CONTAINS + tablolar.
#[allow(clippy::too_many_arguments)]
fn process_items(
    tables: &mut Tables,
    _file_idx: usize,
    module: &str,
    rel_path: &str,
    source_hash: &str,
    items: &[Item],
) {
    let file_key = NodeKey::with_path("File", rel_path.to_string(), rel_path);
    for item in items {
        match item {
            Item::Fn(item_fn) => {
                let name = item_fn.sig.ident.to_string();
                let key = insert_node(
                    tables,
                    NodeKey::with_path("Function", join_q(module, &name), rel_path),
                    json!({}),
                );
                let (start_line, end_line) = span_lines(item_fn);
                let evidence = push_evidence(
                    tables,
                    "ast-span",
                    rel_path,
                    start_line,
                    end_line,
                    source_hash,
                    format!("CONTAINS: '{rel_path}' '{name}' fn bildirimini içerir (syn AST)."),
                );
                push_edge(tables, "CONTAINS", file_key.clone(), key.clone(), "verified", evidence, None);

                if let Some((_, file_fns)) = tables
                    .free_fn_by_file
                    .iter_mut()
                    .find(|(m, _)| m == module)
                {
                    file_fns.insert(name.clone(), key.clone());
                }
                let last_module_segment = module.rsplit("::").next().unwrap_or(module).to_string();
                tables
                    .free_fn_global
                    .entry((last_module_segment, name.clone()))
                    .or_default()
                    .push(key.clone());
                tables
                    .free_fn_bare
                    .entry(name.clone())
                    .or_default()
                    .push(key.clone());

                for attr in &item_fn.attrs {
                    emit_route(tables, attr, &key, rel_path, source_hash);
                }
            }
            Item::Struct(_) | Item::Enum(_) => {
                // ask sözleşmesi: struct ve enum → Class node.
                let name = match item {
                    Item::Struct(s) => s.ident.to_string(),
                    Item::Enum(e) => e.ident.to_string(),
                    _ => unreachable!(),
                };
                let key = insert_node(
                    tables,
                    NodeKey::with_path("Class", join_q(module, &name), rel_path),
                    json!({}),
                );
                let (start_line, end_line) = span_lines(item);
                let evidence = push_evidence(
                    tables,
                    "ast-span",
                    rel_path,
                    start_line,
                    end_line,
                    source_hash,
                    format!("CONTAINS: '{rel_path}' '{name}' bildirimini içerir (syn AST)."),
                );
                push_edge(tables, "CONTAINS", file_key.clone(), key.clone(), "verified", evidence, None);
                tables.declared_types.insert(name, key);
            }
            Item::Trait(item_trait) => {
                let name = item_trait.ident.to_string();
                let key = insert_node(
                    tables,
                    NodeKey::with_path("Interface", join_q(module, &name), rel_path),
                    json!({}),
                );
                let (start_line, end_line) = span_lines(item_trait);
                let evidence = push_evidence(
                    tables,
                    "ast-span",
                    rel_path,
                    start_line,
                    end_line,
                    source_hash,
                    format!("CONTAINS: '{rel_path}' '{name}' trait bildirimini içerir (syn AST)."),
                );
                push_edge(tables, "CONTAINS", file_key.clone(), key.clone(), "verified", evidence, None);
                tables.declared_types.insert(name.clone(), key.clone());

                for trait_item in &item_trait.items {
                    if let syn::TraitItem::Fn(method) = trait_item {
                        let method_name = method.sig.ident.to_string();
                        let method_key = insert_node(
                            tables,
                            NodeKey::with_path(
                                "Method",
                                join_q(module, &format!("{name}::{method_name}")),
                                rel_path,
                            ),
                            json!({}),
                        );
                        let (ms, me) = span_lines(method);
                        let evidence = push_evidence(
                            tables,
                            "ast-span",
                            rel_path,
                            ms,
                            me,
                            source_hash,
                            format!("CONTAINS: '{name}' trait'i '{method_name}' metot bildirimini içerir (syn AST)."),
                        );
                        push_edge(
                            tables,
                            "CONTAINS",
                            key.clone(),
                            method_key.clone(),
                            "verified",
                            evidence,
                            None,
                        );
                        tables
                            .methods
                            .entry((name.clone(), method_name.clone()))
                            .or_default()
                            .push(method_key.clone());
                        tables
                            .methods_bare
                            .entry(method_name.clone())
                            .or_default()
                            .push(method_key.clone());
                        for attr in &method.attrs {
                            emit_route(tables, attr, &method_key, rel_path, source_hash);
                        }
                    }
                }
            }
            Item::Impl(item_impl) => {
                let type_name = match &*item_impl.self_ty {
                    syn::Type::Path(tp) => tp
                        .path
                        .segments
                        .last()
                        .map(|segment| segment.ident.to_string()),
                    _ => None,
                };
                let Some(type_name) = type_name else {
                    continue;
                };
                let Some(type_key) = tables.declared_types.get(&type_name).cloned() else {
                    // Bildirimi analiz setinde olmayan tipin impl'i modellenmez
                    // (açık tanı — sessiz kesim yok).
                    let (line, _) = span_lines(item_impl);
                    tables.diagnostics.push(Diagnostic {
                        relative_path: rel_path.to_string(),
                        code: "IMPL_UNKNOWN_TYPE".to_string(),
                        message: format!(
                            "'{type_name}' analiz setinde bildirilmedi; impl metotları modellenmedi"
                        ),
                        line,
                    });
                    continue;
                };

                for impl_item in &item_impl.items {
                    if let syn::ImplItem::Fn(method) = impl_item {
                        let method_name = method.sig.ident.to_string();
                        let method_key = insert_node(
                            tables,
                            NodeKey::with_path(
                                "Method",
                                join_q(module, &format!("{type_name}::{method_name}")),
                                rel_path,
                            ),
                            json!({}),
                        );
                        let (ms, me) = span_lines(method);
                        let evidence = push_evidence(
                            tables,
                            "ast-span",
                            rel_path,
                            ms,
                            me,
                            source_hash,
                            format!("CONTAINS: '{type_name}' '{method_name}' metot tanımını içerir (syn AST)."),
                        );
                        push_edge(
                            tables,
                            "CONTAINS",
                            type_key.clone(),
                            method_key.clone(),
                            "verified",
                            evidence,
                            None,
                        );
                        tables
                            .methods
                            .entry((type_name.clone(), method_name.clone()))
                            .or_default()
                            .push(method_key.clone());
                        tables
                            .methods_bare
                            .entry(method_name.clone())
                            .or_default()
                            .push(method_key.clone());
                        for attr in &method.attrs {
                            emit_route(tables, attr, &method_key, rel_path, source_hash);
                        }
                    }
                }
            }
            Item::Macro(item_macro) => {
                // Makro ile tanımlı öğeler atlanır (belgeli unsupported).
                let (line, _) = span_lines(item_macro);
                tables.diagnostics.push(Diagnostic {
                    relative_path: rel_path.to_string(),
                    code: "MACRO_ITEM_SKIPPED".to_string(),
                    message: format!(
                        "'{}' makro öğesi modellenmedi (macro-defined-items)",
                        item_macro
                            .mac
                            .path
                            .segments
                            .last()
                            .map(|segment| segment.ident.to_string())
                            .unwrap_or_default()
                    ),
                    line,
                });
            }
            // mod/use/const/static/extern/verbatim öğeleri node üretmez
            // (belgeli unsupported: use-import-resolution).
            _ => {}
        }
    }
}

/// Aynı dosyanın gövde geçişi: her fn/impl metodu için CallVisitor.
fn process_bodies(
    tables: &mut Tables,
    module: &str,
    rel_path: &str,
    source_hash: &str,
    items: &[Item],
) {
    for item in items {
        match item {
            Item::Fn(item_fn) => {
                let name = item_fn.sig.ident.to_string();
                let caller =
                    NodeKey::with_path("Function", join_q(module, &name), rel_path);
                let mut visitor = CallVisitor {
                    rel_path,
                    source_hash,
                    tables,
                    caller,
                };
                visitor.visit_block(&item_fn.block);
            }
            Item::Trait(item_trait) => {
                let name = item_trait.ident.to_string();
                for trait_item in &item_trait.items {
                    if let syn::TraitItem::Fn(method) = trait_item {
                        if let Some(block) = &method.default {
                            let method_name = method.sig.ident.to_string();
                            let caller = NodeKey::with_path(
                                "Method",
                                join_q(module, &format!("{name}::{method_name}")),
                                rel_path,
                            );
                            let mut visitor = CallVisitor {
                                rel_path,
                                source_hash,
                                tables,
                                caller,
                            };
                            visitor.visit_block(block);
                        }
                    }
                }
            }
            Item::Impl(item_impl) => {
                let type_name = match &*item_impl.self_ty {
                    syn::Type::Path(tp) => tp
                        .path
                        .segments
                        .last()
                        .map(|segment| segment.ident.to_string()),
                    _ => None,
                };
                let Some(type_name) = type_name else {
                    continue;
                };
                let Some(_) = tables.declared_types.get(&type_name) else {
                    continue;
                };
                for impl_item in &item_impl.items {
                    if let syn::ImplItem::Fn(method) = impl_item {
                        let method_name = method.sig.ident.to_string();
                        let caller = NodeKey::with_path(
                            "Method",
                            join_q(module, &format!("{type_name}::{method_name}")),
                            rel_path,
                        );
                        let mut visitor = CallVisitor {
                            rel_path,
                            source_hash,
                            tables,
                            caller,
                        };
                        visitor.visit_block(&method.block);
                    }
                }
            }
            _ => {}
        }
    }
}

fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

/// Tam analizi yürütür ve protokol yanıt Value'sunu üretir.
/// max_nodes ≤ 0 ya da üst sınırın üstünde → MaxResponseNodes uygulanır
/// (go worker Analyze clamp deseniyle aynı; protokol katmanı zaten
/// doğrular — buradaki clamp savunma derinliğidir).
pub fn analyze(id: &Value, files: &[FileEntry], max_nodes: usize) -> Value {
    let budget = if max_nodes == 0 || max_nodes > MAX_RESPONSE_NODES {
        MAX_RESPONSE_NODES
    } else {
        max_nodes
    };
    let mut tables = Tables::default();

    // Pass 1: bildirimler (File node'ları her zaman üretilir — bozuk dosya
    // bile sourceHash kanıtlı File node taşır; parse hatası tanıya yazılır).
    let mut parsed_trees: Vec<Option<syn::File>> = Vec::with_capacity(files.len());
    for entry in files {
        let module = module_path_of(&entry.path);
        let source_hash = sha256_hex(entry.content.as_bytes());

        let file_key = NodeKey::with_path("File", entry.path.clone(), &entry.path);
        insert_node(
            &mut tables,
            file_key,
            json!({ "sourceHash": source_hash }),
        );
        tables.free_fn_by_file.push((module.clone(), BTreeMap::new()));

        match syn::parse_file(&entry.content) {
            Ok(tree) => {
                parsed_trees.push(Some(tree));
            }
            Err(err) => {
                let line = err.span().start().line.max(1);
                tables.diagnostics.push(Diagnostic {
                    relative_path: entry.path.clone(),
                    code: "PARSE_ERROR".to_string(),
                    message: format!("dosya ayrıştırılamadı: {err}"),
                    line,
                });
                parsed_trees.push(None);
                continue;
            }
        }
    }

    // Pass 2: CONTAINS + tablolar + route'lar (yalnızca parse edilenler).
    for (idx, entry) in files.iter().enumerate() {
        let Some(tree) = &parsed_trees[idx] else {
            continue;
        };
        let module = module_path_of(&entry.path);
        let source_hash = sha256_hex(entry.content.as_bytes());
        process_items(
            &mut tables,
            idx,
            &module,
            &entry.path,
            &source_hash,
            &tree.items,
        );
    }

    // Pass 3: gövdelerdeki çağrılar (tablo tam olduktan SONRA).
    for (idx, entry) in files.iter().enumerate() {
        let Some(tree) = &parsed_trees[idx] else {
            continue;
        };
        let module = module_path_of(&entry.path);
        let source_hash = sha256_hex(entry.content.as_bytes());
        process_bodies(
            &mut tables,
            &module,
            &entry.path,
            &source_hash,
            &tree.items,
        );
    }

    // Kanonik çıktı düzeni (TŞ §8 invariant iv).
    let mut nodes: Vec<Value> = tables.nodes.values().cloned().collect();
    // Yanıt node bütçesi (go worker RESPONSE_TRUNCATED deseni): kanonik
    // sırada ilk `budget` node yayınlanır; uçları yayınlanmayan kenarlar
    // DÜŞER (dangling yok); evidence yalnızca yayımlanan kenarların
    // taşıdığı kanıtlardan yeniden kurulur; aşım tanısı yazılır — sessiz
    // kesim yoktur (bulgu: kırpılmış yanıt yerine tam L0/L1 degradesi).
    if nodes.len() > budget {
        let kept: BTreeSet<NodeKey> = tables.nodes.keys().take(budget).cloned().collect();
        nodes.truncate(budget);
        tables
            .edges
            .retain(|edge| kept.contains(&edge.from) && kept.contains(&edge.to));
        let mut kept_evidence: Vec<Value> = Vec::new();
        for edge in &tables.edges {
            kept_evidence.extend(edge.evidence.iter().cloned());
        }
        tables.evidence = kept_evidence;
        tables.diagnostics.push(Diagnostic {
            relative_path: String::new(),
            code: "RESPONSE_TRUNCATED".to_string(),
            message: format!(
                "yanıt node bütçesi ({budget}) aşıldı; {budget} node yayınlandı, uçları yayınlanmayan {} kenar düştü (dangling yok)",
                tables.edge_index.len() - tables.edges.len()
            ),
            line: 0,
        });
    }
    tables.edges.sort_by(|a, b| {
        let key_a = (
            a.kind,
            a.from.clone(),
            a.to.clone(),
            a.resolution,
        );
        let key_b = (
            b.kind,
            b.from.clone(),
            b.to.clone(),
            b.resolution,
        );
        key_a.cmp(&key_b)
    });
    let edges: Vec<Value> = tables
        .edges
        .iter()
        .map(|edge| {
            let mut value = json!({
                "kind": edge.kind,
                "from": node_ref_value(&edge.from),
                "to": node_ref_value(&edge.to),
                "resolution": edge.resolution,
                "evidence": edge.evidence,
            });
            if let Some(ambiguity) = &edge.ambiguity {
                value["ambiguity"] = ambiguity.clone();
            }
            value
        })
        .collect();
    let mut evidence: Vec<Value> = tables.evidence.clone();
    evidence.sort_by(|a, b| {
        let key_a = serde_json::to_string(a).unwrap_or_default();
        let key_b = serde_json::to_string(b).unwrap_or_default();
        key_a.cmp(&key_b)
    });
    evidence.dedup_by(|a, b| a == b);

    let diagnostics: Vec<Value> = tables
        .diagnostics
        .iter()
        .map(|diagnostic| {
            json!({
                "relativePath": diagnostic.relative_path,
                "code": diagnostic.code,
                "message": diagnostic.message,
                "line": diagnostic.line,
            })
        })
        .collect();

    let total_edges = edges.len();
    let verified_edges = tables
        .edges
        .iter()
        .filter(|edge| edge.resolution == "verified")
        .count();
    let coverage = if total_edges == 0 {
        0.0
    } else {
        round4(verified_edges as f64 / total_edges as f64)
    };

    let status = if tables.diagnostics.is_empty() {
        "ready"
    } else {
        "partial"
    };

    json!({
        "id": id,
        "protocolVersion": crate::protocol::PROTOCOL_VERSION,
        "status": status,
        "worker": {
            "analyzerId": ANALYZER_ID,
            "analyzerVersion": ANALYZER_VERSION,
        },
        "capabilities": {
            "astParse": true,
            "symbolResolution": true,
            "containsEdges": true,
            "callEdges": true,
            "importEdges": false,
            "routeDetection": ROUTE_DETECTION,
            "frameworkLinkers": false,
        },
        "coverageRatio": coverage,
        "unsupportedConstructs": UNSUPPORTED_CONSTRUCTS,
        "warnings": [],
        "diagnostics": diagnostics,
        "nodes": nodes,
        "edges": edges,
        "evidence": evidence,
    })
}

fn node_ref_value(key: &NodeKey) -> Value {
    let mut value = json!({
        "kind": key.kind,
        "qualifiedName": key.qualified,
    });
    if !key.rel_path.is_empty() {
        value["relativePath"] = Value::String(key.rel_path.clone());
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find_call<'a>(edges: &'a [Value], from: &str, to: &str) -> Option<&'a Value> {
        edges.iter().find(|e| {
            e["kind"] == "CALLS"
                && e["from"]["qualifiedName"] == from
                && e["to"]["qualifiedName"] == to
        })
    }

    #[test]
    fn two_segment_suffix_match_emits_heuristic_with_explicit_ambiguity_never_verified() {
        let files = vec![
            FileEntry {
                path: "src/main.rs".to_string(),
                content: [
                    "fn local_helper() {}",
                    "fn entry() {",
                    "    local_helper();",
                    "    let _s = other::services::OrdersService::new();",
                    "    other_mod::util::compute();",
                    "}",
                ]
                .join("\n"),
            },
            FileEntry {
                path: "src/services.rs".to_string(),
                content: [
                    "pub struct OrdersService;",
                    "impl OrdersService {",
                    "    pub fn new() -> Self { OrdersService }",
                    "}",
                ]
                .join("\n"),
            },
            FileEntry {
                path: "src/util.rs".to_string(),
                content: "pub fn compute() -> u32 { 42 }\n".to_string(),
            },
        ];

        let result = analyze(&json!("rust-honesty-1"), &files, 0);
        let edges = result["edges"].as_array().expect("edges array");

        // 1) Same-module bare call remains verified.
        let local = find_call(edges, "crate::entry", "crate::local_helper")
            .expect("same-module bare call edge");
        assert_eq!(local["resolution"], "verified");

        // 2) 2-segment suffix match for Type::method MUST be heuristic + explicit ambiguity (NEVER verified).
        let svc_new = find_call(edges, "crate::entry", "crate::services::OrdersService::new")
            .expect("OrdersService::new edge");
        assert_eq!(svc_new["resolution"], "heuristic");
        assert_eq!(
            svc_new["ambiguity"]["candidates"],
            json!(["crate::services::OrdersService::new"])
        );
        assert!(
            svc_new["ambiguity"]["reason"]
                .as_str()
                .unwrap_or("")
                .contains("unverified-module-prefix-suffix-match"),
            "expected unverified-module-prefix-suffix-match reason, got: {:?}",
            svc_new["ambiguity"]
        );

        // 3) 2-segment suffix match for mod::fn MUST be heuristic + explicit ambiguity (NEVER verified).
        let util_fn = find_call(edges, "crate::entry", "crate::util::compute")
            .expect("util::compute edge");
        assert_eq!(util_fn["resolution"], "heuristic");
        assert_eq!(
            util_fn["ambiguity"]["candidates"],
            json!(["crate::util::compute"])
        );
        assert!(
            util_fn["ambiguity"]["reason"]
                .as_str()
                .unwrap_or("")
                .contains("unverified-module-prefix-suffix-match"),
            "expected unverified-module-prefix-suffix-match reason, got: {:?}",
            util_fn["ambiguity"]
        );
    }
}
