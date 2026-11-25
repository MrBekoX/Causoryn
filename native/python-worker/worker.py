#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Causoryn Python sidecar worker — protokol v1 (native/python-worker/PROTOCOL.md).

LLM çalıştırmayan, yerel ve deterministik Python çözümleyicisi. Yalnızca
Python stdlib kullanır (ast + hashlib + json + sys — sıfır dış bağımlılık).
Süreç stdin'den satır satır istek okur, her isteğe tek satır JSON yanıt
döner ve analiz boyunca kullanıcı workspace'ine HİÇBİR YAZMA yapmaz
(ADR-008 deseni; roslyn-worker ile aynı süreç sözleşmesi).

Desen kaynağı: native/roslyn-worker (Program.cs/WorkerAnalyzer.cs) ve
adapters/csharp-roslyn — stdin/stdout satır-bazlı JSON, PROTOCOL.md,
graceful fallback. TŞ v2.1 §7: "Python FastAPI/Django — Python AST +
framework rules; L1/L2, seçili L3".

Kırmızı çizgiler (proje sözleşmesi):
- stdout'ta YALNIZCA protokol satırları taşınır; loglar stderr'e yazılır
  ("[python-worker] " öneki ile).
- Spawn güvenliği: bu script yalnızca SABİT yolla çağrılır; istek içeriği
  yalnızca stdin üzerinden taşınır; hiçbir girdi komuta interpole edilmez.
- Determinizm: aynı files girdisi → birebir aynı yanıt satırı (saat okunmaz,
  çıktı kanonik anahtarla sıralanır).

Çözümleme dürüstlük kuralları (TŞ §8 resolution):
- verified   : hedef AYNI modülde tanımlı (AST isim bağlamı; modül düzeyi
               ad, self.<m>, AynıModülSınıfı.<m>) ya da dekoratör handler
               ilişkisi (dekoratör handler'ın kendisine sözdizimsel bağlıdır).
- heuristic  : hedef IMPORT EDİLEN modül sembolü (tam type inference YOK —
               Python ad bağlamı dinamiktir; kenar ambiguity ile işaretli).
- unresolved : çözülemeyen çağrılar → açık UnknownExternal node; uydurma
               hedef/kenar üretilmez.

Çıkış kodları: 0 = normal EOF; 1 = stdio kablosu kırıldı (BrokenPipeError).
"""

from __future__ import annotations

import ast
import hashlib
import json
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

PROTOCOL_VERSION = "1"
ANALYZER_ID = "python-worker"
ANALYZER_VERSION = "0.1.0"

# Kaynak sınırları — roslyn-worker Protocol.cs ile aynı bütçeler (TŞ §9;
# K-010: yalnızca boyut limitleri). Sabittir, istekte yapılandırılamaz.
MAX_REQUEST_LINE_BYTES = 64 * 1024 * 1024
MAX_FILE_COUNT = 5000
MAX_FILE_CONTENT_BYTES = 2_000_000
MAX_RESPONSE_NODES = 250_000

# AST gezinme derinlik savunması (roslyn MAX_TRAVERSAL_DEPTH karşılığı).
# NOT (takım denetimi bulgusu): birincil savunma CPython parser'ının
# YAPISAL SINIRLARI'dır — çok derin iç içe yapılar ast.parse aşamasında
# SyntaxError ('too many levels of indentation' / 'too many nested
# parentheses') ile reddedilir ve dosya başına partial tanısı yazılır
# (tests/python-worker.test.ts 'aşırı derin iç içe yapı' testi). Bu sayaç
# yalnızca parse edilebilir derinlik aralığında İKİNCİL katmandır ve tipik
# koşumda tetiklenmez. SÜREÇ YAŞAMLILIĞININ GERÇEK MEKANİZMASI (takım
# denetimi tur-2): bildirim/çağrı gezinmesi REKÜRSİFTİR (_declare/
# _walk_calls) — beklenmedik derinlik RecursionError üretebilir; süreç
# bununla ölmez çünkü handle_line'ın analiz gövdesini saran except
# Exception savunması her istisnayı istek-başına hata/INTERNAL_ERROR
# yanıtına çevirir ve döngüyü ayakta tutar (json.loads derin JSON
# RecursionError'u da ayrıca yakalanır — 'derin iç içe JSON' testi).
#
# The limit keeps headroom below the interpreter recursion limit (1000 by
# default): the walk frames plus the frames above them and an ast.unparse of
# a sub-expression must fit. A RecursionError that still occurs is isolated
# per file (and per callable in the call pass): that file gets an
# ADAPTER_INTERNAL diagnostic and the rest of the batch is analyzed.
MAX_AST_DEPTH = max(100, min(500, sys.getrecursionlimit() // 2))

# Upper bound for rendered expression text (ast.unparse) in qualified names,
# rationales and warnings; longer renderings are cut and suffixed with a
# content digest so distinct expressions stay distinct.
MAX_RENDERED_EXPRESSION_CHARS = 200

# TŞ §8 katalogları — worker liste dışı tür üretemez (çıkışta sert doğrulama).
NODE_KINDS = frozenset(
    {
        "Workspace", "Repository", "Project", "Module", "Package", "File",
        "Namespace", "Class", "Interface", "Type", "Function", "Method",
        "Endpoint", "Handler", "Event", "Topic", "Queue", "Database", "Table",
        "Column", "ApiContract", "EventContract", "SchemaContract",
        "ContractVersion", "Test", "Config", "UnknownExternal",
    }
)
EDGE_KINDS = frozenset(
    {
        "CONTAINS", "IMPORTS", "DECLARES", "CALLS", "REFERENCES", "IMPLEMENTS",
        "INHERITS", "INJECTS", "ROUTES_TO", "READS", "WRITES", "PUBLISHES",
        "SUBSCRIBES", "HANDLES", "PRODUCES_CONTRACT", "CONSUMES_CONTRACT",
        "VALIDATES", "TESTS", "DEPENDS_ON", "CONFIGURES",
    }
)
RESOLUTIONS = frozenset({"verified", "heuristic", "unresolved"})
EVIDENCE_KINDS = frozenset(
    {
        "ast-span", "semantic-symbol", "route-attribute", "di-registration",
        "openapi-spec", "asyncapi-spec", "migration-schema", "config-manifest",
        "git-diff", "test-assertion", "runtime-trace",
    }
)

# Framework route kuralları (TŞ §7: Python AST + framework rules, seçili L3).
# Taşıyıcı adına (app/router/api/bp...) kısıt KOYULMAZ: HTTP fiili / api_route
# / route adlı dekoratör kullanımında fiilen yalnızca rota kaydı yapılır;
# taşıyıcı semantik olarak çözümlenmediği için Endpoint, dekoratörün LİTERAL
# argümanlarından türetilir (TŞ §8: kanıt route-attribute).
HTTP_VERB_DECORATORS = frozenset(
    {"get", "post", "put", "patch", "delete", "head", "options", "trace"}
)
ROUTE_NAMED_DECORATORS = frozenset({"route", "api_route"})

UNSUPPORTED_CONSTRUCTS = [
    "monkey-patching",
    "runtime-dependency-injection",
    "dynamic-import (importlib/__import__)",
    "local-variable-type-inference",
    "module-level-calls (no caller)",
    "decorator-arg-non-literal-path",
    "function-level-imports (module-level import table only)",
]

_DRIVE_LETTER = re.compile(r"^[A-Za-z]:")


def log(message: str) -> None:
    """Loglar YALNIZCA stderr'e yazılır (kırmızı çizgi 4)."""
    print(f"[python-worker] {message}", file=sys.stderr, flush=True)


def _force_utf8_stderr() -> None:
    """Log kanalını UTF-8'e sabitler (takım denetimi bulgusu).

    Piped stderr, PYTHONIOENCODING setli değilken Windows'ta locale kod
    sayfasına (ör. cp1254) düşer; Türkçe log metni bozulur ve adapter
    stderr'i UTF-8 okuyup fallback warnings'ine bozuk gömer. stdout protokol
    kanalı zaten binary buffer ile UTF-8'dir; bu düzeltme yalnızca log
    kanalı içindir. Adapter tarafında da spawn env'inde PYTHONIOENCODING
    sabitlenir (çifte savunma; parent env'e bağımlılık yoktur).
    """
    reconfigure = getattr(sys.stderr, "reconfigure", None)
    if callable(reconfigure):
        try:
            reconfigure(encoding="utf-8")
        except (OSError, ValueError):
            pass  # reconfigure desteklenmiyorsa binary stdout disiplini yine sağlamdır


_force_utf8_stderr()


def canonical(value: Any) -> str:
    """Kanonik JSON dizesi — deterministik sıralama/dedupe anahtarı."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_hex(content: str) -> str:
    """UTF-8 SHA-256 — domain sha256Hex(utf8Encode(content)) ile bit-bit aynı."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def bounded_text(text: str) -> str:
    """Caps rendered text at MAX_RENDERED_EXPRESSION_CHARS (plus a digest suffix)."""
    if len(text) <= MAX_RENDERED_EXPRESSION_CHARS:
        return text
    digest = hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()[:12]
    return f"{text[:MAX_RENDERED_EXPRESSION_CHARS]}...#{digest}"


def render_expression(node: ast.AST, source: str) -> str:
    """Bounded `ast.unparse` rendering of an expression.

    ast.unparse is recursive: an expression too deep to render falls back to
    its (non-recursive) source segment, or to a positional placeholder.
    """
    try:
        return bounded_text(ast.unparse(node))
    except (RecursionError, ValueError):
        segment = None
        try:
            segment = ast.get_source_segment(source, node)
        except (RecursionError, ValueError):
            segment = None
        if segment:
            return bounded_text(segment)
        line = getattr(node, "lineno", 0)
        column = getattr(node, "col_offset", 0)
        return f"<expression at {line}:{column}>"


def module_name_from_path(relative_path: str) -> str:
    """Workspace-relative POSIX yol → Python modül adı.

    "app.py" → "app"; "services/orders_service.py" → "services.orders_service";
    "pkg/__init__.py" → "pkg". Türetilemezse (kök __init__.py) relative_path.
    """
    without_ext = relative_path[:-3] if relative_path.endswith(".py") else relative_path
    parts = [part for part in without_ext.split("/") if part]
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts) if parts else relative_path


def error_response(request_id: Any, code: str, message: str) -> Dict[str, Any]:
    return {
        "id": request_id,
        "protocolVersion": PROTOCOL_VERSION,
        "status": "error",
        "error": {"code": code, "message": message},
    }


def describe_id(value: Any) -> str:
    if value is None:
        return "null"
    return value if isinstance(value, str) else str(value)


# ---------------------------------------------------------------------------
# İstek doğrulama — kesin şema reddi (bilinmeyen alan INVALID_ARGUMENT)
# ---------------------------------------------------------------------------

_ALLOWED_TOP_LEVEL = frozenset({"id", "type", "protocolVersion", "files", "maxNodes"})
_ALLOWED_FILE_KEYS = frozenset({"path", "content"})


def valid_id(value: Any) -> bool:
    """id: string veya sayı (bool hariç — JSON true/false sayı değildir)."""
    return isinstance(value, (str, int)) and not isinstance(value, bool)


def validate_relative_path(raw: Any) -> Tuple[Optional[str], Optional[str]]:
    """POSIX workspace-relative yol sözleşmesi. (path, hata_mesajı) döner."""
    if not isinstance(raw, str) or len(raw) == 0:
        return None, "files[].path must not be empty"
    if "\\" in raw:
        return None, f"files[].path must be a POSIX path (backslashes are not accepted): {raw}"
    if raw.startswith("/"):
        return None, f"files[].path must not be an absolute path: {raw}"
    if _DRIVE_LETTER.match(raw):
        return None, f"files[].path must not be an absolute path with a drive letter: {raw}"
    for segment in raw.split("/"):
        if len(segment) == 0:
            return None, f"files[].path contains an empty segment: {raw}"
        if segment == ".":
            return None, f"files[].path contains a '.' segment: {raw}"
        if segment == "..":
            return None, f"files[].path escapes the workspace root ('..'): {raw}"
    return raw, None


def validate_request(payload: Any) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """(istek, None) ya da (None, error_response) döner."""
    if not isinstance(payload, dict):
        return None, error_response(None, "INVALID_ARGUMENT", "request must be a JSON object")

    raw_id = payload.get("id")
    echoed_id: Any = raw_id if valid_id(raw_id) else None

    unknown = sorted(set(payload.keys()) - _ALLOWED_TOP_LEVEL)
    if unknown:
        return None, error_response(
            echoed_id,
            "INVALID_ARGUMENT",
            f"unknown request field(s): {', '.join(unknown)}",
        )

    if "id" not in payload or not valid_id(raw_id):
        return None, error_response(
            None, "INVALID_ARGUMENT", "id is required and must be a string or a number"
        )

    if payload.get("type") != "analyze":
        return None, error_response(
            echoed_id,
            "INVALID_ARGUMENT",
            f"type must be 'analyze': {payload.get('type')!r}",
        )

    protocol_version = payload.get("protocolVersion")
    if protocol_version is not None and protocol_version != PROTOCOL_VERSION:
        return None, error_response(
            echoed_id,
            "INVALID_ARGUMENT",
            f"unsupported protocolVersion: {protocol_version!r}",
        )

    max_nodes = payload.get("maxNodes")
    if max_nodes is not None:
        if isinstance(max_nodes, bool) or not isinstance(max_nodes, int):
            return None, error_response(echoed_id, "INVALID_ARGUMENT", "maxNodes must be an integer")
        if not (1 <= max_nodes <= MAX_RESPONSE_NODES):
            return None, error_response(
                echoed_id,
                "INVALID_ARGUMENT",
                f"maxNodes must be in the range 1..{MAX_RESPONSE_NODES}: {max_nodes}",
            )

    files = payload.get("files")
    if not isinstance(files, list) or len(files) == 0:
        return None, error_response(echoed_id, "INVALID_ARGUMENT", "files must be a non-empty array")
    if len(files) > MAX_FILE_COUNT:
        return None, error_response(
            echoed_id,
            "LIMIT_EXCEEDED",
            f"file count limit exceeded: {len(files)} > {MAX_FILE_COUNT}",
        )

    seen_paths: set = set()
    for index, item in enumerate(files):
        if not isinstance(item, dict):
            return None, error_response(
                echoed_id, "INVALID_ARGUMENT", f"files[{index}] must be an object"
            )
        unknown_file_keys = sorted(set(item.keys()) - _ALLOWED_FILE_KEYS)
        if unknown_file_keys:
            return None, error_response(
                echoed_id,
                "INVALID_ARGUMENT",
                f"files[{index}] contains unknown field(s): {', '.join(unknown_file_keys)}",
            )
        path, path_error = validate_relative_path(item.get("path"))
        if path_error is not None:
            return None, error_response(echoed_id, "INVALID_ARGUMENT", path_error)
        if path in seen_paths:
            return None, error_response(
                echoed_id, "INVALID_ARGUMENT", f"the same source path was given twice: {path}"
            )
        seen_paths.add(path)
        content = item.get("content")
        if not isinstance(content, str):
            return None, error_response(
                echoed_id, "INVALID_ARGUMENT", f"files[{index}].content must be a string"
            )
        content_bytes = len(content.encode("utf-8"))
        if content_bytes > MAX_FILE_CONTENT_BYTES:
            return None, error_response(
                echoed_id,
                "LIMIT_EXCEEDED",
                f"file content size limit exceeded: {path} "
                f"({content_bytes} > {MAX_FILE_CONTENT_BYTES} bytes)",
            )

    request: Dict[str, Any] = {
        "id": raw_id,
        "files": [{"path": item["path"], "content": item["content"]} for item in files],
    }
    if max_nodes is not None:
        request["maxNodes"] = max_nodes
    return request, None


# ---------------------------------------------------------------------------
# Analiz — bildirim, route ve çağrı çözümleme
# ---------------------------------------------------------------------------

class FileAnalyzer:
    """Tek dosyanın AST çözümlemesi; sonuçlar istek düzeyi toplayıcıya yazılır."""

    def __init__(
        self,
        relative_path: str,
        content: str,
        tree: ast.AST,
        collector: "RequestCollector",
    ) -> None:
        self.path = relative_path
        self.content = content
        self.source_hash = sha256_hex(content)
        self.module = module_name_from_path(relative_path)
        self.tree = tree
        self.collector = collector
        # Modül düzeyi ad tablosu: ad → (node_kind, qualified_name)
        self.module_symbols: Dict[str, Tuple[str, str]] = {}
        # Sınıf üye tablosu: class_qualified_name → {üye adı → (kind, qn)}
        self.class_members: Dict[str, Dict[str, Tuple[str, str]]] = {}
        # import bağlama tablosu: yerel ad → ("module", dotted) | ("symbol", dotted, ad)
        self.import_bindings: Dict[str, Tuple[str, ...]] = {}
        # Çağrı sahipleri: (ast node, kind, qn, class_qn)
        self.callables: List[Tuple[ast.stmt, str, str, Optional[str]]] = []
        self.depth_exceeded = False
        self.recursion_exceeded = False

    # -- yardımcılar ----------------------------------------------------------

    def file_ref(self) -> Dict[str, Any]:
        return {"kind": "File", "qualifiedName": self.path, "relativePath": self.path}

    def ref(self, kind: str, qualified_name: str) -> Dict[str, Any]:
        return {"kind": kind, "qualifiedName": qualified_name, "relativePath": self.path}

    def external_ref(self, qualified_name: str) -> Dict[str, Any]:
        """Dış/çözümsüz hedef: dosya taşımaz (analiz seti dışı sembol)."""
        return {"kind": "UnknownExternal", "qualifiedName": bounded_text(qualified_name)}

    def render(self, node: ast.AST) -> str:
        """Bounded rendering of an expression of this file (see render_expression)."""
        return render_expression(node, self.content)

    def span(self, start_line: Optional[int], end_line: Optional[int]) -> Dict[str, Any]:
        start = start_line if isinstance(start_line, int) and start_line > 0 else 0
        end = end_line if isinstance(end_line, int) and end_line >= start else start
        return {
            "relativePath": self.path,
            "startLine": start,
            "endLine": end,
            "sourceHash": self.source_hash,
        }

    def evidence(self, kind: str, node: ast.AST, rationale: str) -> Dict[str, Any]:
        return {
            "kind": kind,
            "span": self.span(getattr(node, "lineno", None), getattr(node, "end_lineno", None)),
            "analyzerId": ANALYZER_ID,
            "analyzerVersion": ANALYZER_VERSION,
            "rationale": rationale,
        }

    # -- geçiş 1: bildirimler ---------------------------------------------------

    def analyze(self) -> None:
        self.collector.add_file_node(self.path, self.source_hash)
        self._register_imports(self.tree.body)
        try:
            for statement in self.tree.body:
                self._declare(statement, prefix=self.module, parent=self.file_ref(),
                              in_class=False, class_qn=None, depth=1)
        except RecursionError:
            # Isolated per file: the declarations collected so far are kept.
            self.recursion_exceeded = True
        # Çok dosyalı setlerde import çözümlemesi için semboller global kayda yazılır.
        for kind, qualified in self.module_symbols.values():
            self.collector.register_symbol(qualified, kind, self.path)
        for class_qn, members in self.class_members.items():
            self.collector.register_class_members(
                class_qn,
                {name: (member_kind, member_qn, self.path)
                 for name, (member_kind, member_qn) in members.items()},
            )

    def _declare(
        self,
        statement: ast.stmt,
        prefix: str,
        parent: Dict[str, Any],
        in_class: bool,
        class_qn: Optional[str],
        depth: int,
    ) -> None:
        if depth > MAX_AST_DEPTH:
            self.depth_exceeded = True
            return

        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            name = statement.name
            kind = "Method" if in_class else "Function"
            qualified = f"{prefix}.{name}"
            self.collector.add_node(kind, qualified, self.path, span=declaration_span(statement))
            self.collector.add_contains(
                parent, self.ref(kind, qualified),
                self.evidence(
                    "ast-span",
                    statement,
                    f"CONTAINS: the {kind.lower()} declaration {qualified} in {self.path} "
                    "was matched with AST span evidence.",
                ),
            )
            if prefix == self.module:
                self.module_symbols[name] = (kind, qualified)
            if in_class and class_qn is not None:
                self.class_members.setdefault(class_qn, {})[name] = (kind, qualified)
            self.callables.append((statement, kind, qualified, class_qn))
            self._collect_routes(statement, qualified, kind)
            # Fonksiyon gövdesindeki iç içe bildirimler ayrı kayıt olur
            # (sınıf üyesi DEĞİLDİR — in_class=False).
            for child in statement.body:
                self._declare(child, prefix=qualified, parent=self.ref(kind, qualified),
                              in_class=False, class_qn=None, depth=depth + 1)
            return

        if isinstance(statement, ast.ClassDef):
            name = statement.name
            qualified = f"{prefix}.{name}"
            self.collector.add_node("Class", qualified, self.path, span=declaration_span(statement))
            self.collector.add_contains(
                parent, self.ref("Class", qualified),
                self.evidence(
                    "ast-span",
                    statement,
                    f"CONTAINS: the class declaration {qualified} in {self.path} "
                    "was matched with AST span evidence.",
                ),
            )
            if prefix == self.module:
                self.module_symbols[name] = ("Class", qualified)
            self.class_members.setdefault(qualified, {})
            class_ref = self.ref("Class", qualified)
            for child in statement.body:
                self._declare(child, prefix=qualified, parent=class_ref,
                              in_class=True, class_qn=qualified, depth=depth + 1)
            return

        # Diğer deyimlerin gövdesi bildirim geçişinde taranmaz (L1 odaklı).
        return

    # -- route kuralları (seçili L3) ---------------------------------------------

    def _collect_routes(self, function_node: ast.stmt, handler_qn: str, handler_kind: str) -> None:
        for decorator in getattr(function_node, "decorator_list", []):
            if not isinstance(decorator, ast.Call):
                continue
            func = decorator.func
            if not isinstance(func, ast.Attribute):
                # Bare ad dekoratörü (@get vb.) rota taşıyıcısı değildir;
                # yaygın dekoratörler (@property vb.) zaten eşleşmez — sessiz atlanır.
                continue
            if not isinstance(func.value, ast.Name):
                # Takım denetimi bulgusu: @routers['main'].get('/x') gibi
                # basit-ad olmayan taşıyıcılar SESSİZCE atlanıyordu;
                # 'sessiz kesim yoktur' disipliniyle açık uyarı yazılır.
                if func.attr in HTTP_VERB_DECORATORS or func.attr in ROUTE_NAMED_DECORATORS:
                    self.collector.add_warning(
                        f"{self.path}: decorator carrier '{self.render(func)}' is not a simple name; "
                        f"no endpoint was produced for {handler_qn}"
                    )
                continue
            carrier = func.value.id
            attr = func.attr
            verbs: List[str] = []
            path: Optional[str] = None

            if attr in HTTP_VERB_DECORATORS:
                verbs = [attr.upper()]
                path = self._literal_str(decorator, 0)
            elif attr in ROUTE_NAMED_DECORATORS:
                path = self._literal_str(decorator, 0)
                verbs = self._methods_kwarg(decorator)
            else:
                continue

            if path is None:
                self.collector.add_warning(
                    f"{self.path}: the route path of decorator '{carrier}.{attr}' is not a "
                    f"literal string; no endpoint was produced for {handler_qn}"
                )
                continue

            for verb in verbs:
                endpoint_qn = f"{verb} {path}"
                self.collector.add_node(
                    "Endpoint", endpoint_qn, self.path,
                    attributes={"method": verb, "path": path},
                )
                self.collector.add_route(
                    self.ref("Endpoint", endpoint_qn),
                    self.ref(handler_kind, handler_qn),
                    self.evidence(
                        "route-attribute",
                        decorator,
                        f"ROUTES_TO: {self.render(decorator)} is bound to handler "
                        f"{handler_qn} (verified).",
                    ),
                )

    def _literal_str(self, call: ast.Call, position: int) -> Optional[str]:
        if position < len(call.args):
            arg = call.args[position]
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                return arg.value
        return None

    def _methods_kwarg(self, call: ast.Call) -> List[str]:
        for keyword in call.keywords:
            if keyword.arg == "methods" and isinstance(keyword.value, ast.List):
                verbs = []
                for element in keyword.value.elts:
                    if isinstance(element, ast.Constant) and isinstance(element.value, str):
                        verb = element.value.strip().upper()
                        if verb:
                            verbs.append(verb)
                if verbs:
                    return verbs
        return ["GET"]  # Flask varsayılanı: methods belirtilmezse GET.

    # -- import tablosu (yalnızca modül düzeyi) -----------------------------------

    def _register_imports(self, body: List[ast.stmt]) -> None:
        for statement in body:
            if isinstance(statement, ast.Import):
                for alias in statement.names:
                    bind = alias.asname or alias.name.split(".")[0]
                    self.import_bindings[bind] = ("module", alias.name)
            elif isinstance(statement, ast.ImportFrom):
                level = statement.level or 0
                # Mutlak import (level=0) taban PAKET ALMAZ; yalnızca göreli
                # import (level>0) dosyanın paketine göre çözülür.
                base = self._relative_import_base(level) if level > 0 else ""
                if statement.module is None and level > 0:
                    # from . import altmodul
                    for alias in statement.names:
                        bind = alias.asname or alias.name
                        dotted = f"{base}.{alias.name}" if base else alias.name
                        self.import_bindings[bind] = ("module", dotted)
                else:
                    dotted_module = statement.module or ""
                    if base and dotted_module:
                        dotted_module = f"{base}.{dotted_module}"
                    elif base:
                        dotted_module = base
                    for alias in statement.names:
                        bind = alias.asname or alias.name
                        self.import_bindings[bind] = ("symbol", dotted_module, alias.name)

    def _relative_import_base(self, level: int) -> str:
        """Göreli import tabanı: level=1 → dosyanın paketi; level=n → (n-1) üst paket."""
        package_parts = self.module.split(".")[:-1] if "." in self.module else []
        drop = level - 1
        if drop > len(package_parts):
            return ""
        if drop == 0:
            return ".".join(package_parts)
        return ".".join(package_parts[: len(package_parts) - drop])

    # -- geçiş 2: çağrı çözümleme ---------------------------------------------------

    def resolve_calls(self) -> None:
        for node, kind, qualified, class_qn in self.callables:
            try:
                for statement in node.body:
                    self._walk_calls(statement, (kind, qualified, class_qn), depth=1)
            except RecursionError:
                # Isolated per callable: its remaining calls are skipped.
                self.recursion_exceeded = True

    def _walk_calls(
        self,
        statement: ast.AST,
        owner: Tuple[str, str, Optional[str]],
        depth: int,
    ) -> None:
        if depth > MAX_AST_DEPTH:
            self.depth_exceeded = True
            return

        if isinstance(statement, ast.Call):
            self._resolve_call(statement, owner)

        # İç içe bildirimlere İNİLMEZ: kendi gövdeleri, bildirim geçişinde
        # kaydedildikleri kendi callables kaydıyla ayrı sahiplikle gezilir.
        for child in ast.iter_child_nodes(statement):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            self._walk_calls(child, owner, depth + 1)

    def _resolve_call(self, call: ast.Call, owner: Tuple[str, str, Optional[str]]) -> None:
        owner_kind, owner_qn, owner_class_qn = owner
        caller_ref = self.ref(owner_kind, owner_qn)
        func = call.func

        def finish(
            resolution: str,
            target_ref: Dict[str, Any],
            rationale: str,
            ambiguity: Optional[Dict[str, Any]] = None,
        ) -> None:
            self.collector.add_calls(
                caller_ref,
                target_ref,
                resolution,
                self.evidence("ast-span", call, rationale),
                ambiguity,
            )

        if isinstance(func, ast.Name):
            name = func.id
            if name in self.module_symbols:
                target_kind, target_qn = self.module_symbols[name]
                finish(
                    "verified", self.ref(target_kind, target_qn),
                    f"CALLS: {owner_qn} → {target_qn} resolved via the AST name binding of "
                    f"'{name}' defined in the same module (verified).",
                )
            elif name in self.import_bindings:
                self._resolve_imported(name, [], owner_qn, finish)
            else:
                finish(
                    "unresolved", self.external_ref(name),
                    f"CALLS: {owner_qn} → {name} could not be resolved (unresolved); "
                    "no fabricated target was produced.",
                )
            return

        if isinstance(func, ast.Attribute):
            chain = self._dotted_chain(func)
            if chain is None:
                source = self.render(func)
                finish(
                    "unresolved", self.external_ref(source),
                    f"CALLS: {owner_qn} → {source} could not be resolved (unresolved); "
                    "no fabricated target was produced.",
                )
                return

            root, rest = chain[0], chain[1:]

            # self.<m>: sarmalayan sınıfın üye tablosu (lexical olarak kesin).
            if root == "self" and owner_class_qn is not None and rest:
                member = self.class_members.get(owner_class_qn, {}).get(rest[0])
                if member is not None:
                    finish(
                        "verified", self.ref(member[0], member[1]),
                        f"CALLS: {owner_qn} → {member[1]} resolved 'self.{rest[0]}' via the "
                        f"member table of the enclosing class {owner_class_qn} (verified).",
                    )
                else:
                    finish(
                        "unresolved", self.external_ref(".".join(chain)),
                        f"CALLS: {owner_qn} → {bounded_text('.'.join(chain))} could not be resolved (unresolved); "
                        "no fabricated target was produced.",
                    )
                return

            # AynıModülSınıfı.<m>: sınıf üye tablosu.
            if len(rest) == 1 and root in self.module_symbols:
                target_kind, target_qn = self.module_symbols[root]
                if target_kind == "Class":
                    member = self.class_members.get(target_qn, {}).get(rest[0])
                    if member is not None:
                        finish(
                            "verified", self.ref(member[0], member[1]),
                            f"CALLS: {owner_qn} → {member[1]} resolved via the member table "
                            f"of class {target_qn} defined in the same module (verified).",
                        )
                    else:
                        finish(
                            "unresolved", self.external_ref(".".join(chain)),
                            f"CALLS: {owner_qn} → {bounded_text('.'.join(chain))} could not be resolved (unresolved); "
                            "no fabricated target was produced.",
                        )
                    return
                # Modül düzeyi fonksiyon niteliği (ör. func.attr) çözümlenmez.
                finish(
                    "unresolved", self.external_ref(".".join(chain)),
                    f"CALLS: {owner_qn} → {bounded_text('.'.join(chain))} could not be resolved (unresolved); "
                    "no fabricated target was produced.",
                )
                return

            if root in self.import_bindings:
                self._resolve_imported(root, rest, owner_qn, finish)
                return

            finish(
                "unresolved", self.external_ref(".".join(chain)),
                f"CALLS: {owner_qn} → {bounded_text('.'.join(chain))} could not be resolved (unresolved); "
                "no fabricated target was produced.",
            )
            return

        source = self.render(func)
        finish(
            "unresolved", self.external_ref(source),
            f"CALLS: {owner_qn} → {source} could not be resolved (unresolved); "
            "no fabricated target was produced.",
        )

    def _dotted_chain(self, node: ast.AST) -> Optional[List[str]]:
        """Attribute/Name zincirini kökten sona ad listesine indirir; değilse None."""
        parts: List[str] = []
        current: ast.AST = node
        while isinstance(current, ast.Attribute):
            parts.append(current.attr)
            current = current.value
        if not isinstance(current, ast.Name):
            return None
        parts.append(current.id)
        parts.reverse()
        return parts

    def _resolve_imported(
        self,
        binding_name: str,
        rest: List[str],
        owner_qn: str,
        finish: Any,
    ) -> None:
        binding = self.import_bindings.get(binding_name)
        if binding is None:  # savunma: çağıran zaten kontrol etti
            return
        module_set = self.collector.module_set

        if binding[0] == "module":
            dotted = binding[1]
            symbol_parts = list(rest)
            # Paket zinciri: dotted + rest[0] da analiz setinde modül olabilir.
            while (
                symbol_parts
                and len(symbol_parts) > 1
                and f"{dotted}.{symbol_parts[0]}" in module_set
            ):
                dotted = f"{dotted}.{symbol_parts[0]}"
                symbol_parts = symbol_parts[1:]

            if symbol_parts:
                symbol_name = symbol_parts[0]
                target_qn = f"{dotted}.{symbol_name}"
                registry_entry = self.collector.symbol_registry.get(target_qn)
                if dotted in module_set and registry_entry is not None:
                    target_kind, target_relative_path = registry_entry
                    finish(
                        "heuristic",
                        {"kind": target_kind, "qualifiedName": target_qn,
                         "relativePath": target_relative_path},
                        f"CALLS: {owner_qn} → {target_qn} resolved through an imported "
                        "module symbol (heuristic; no full type inference).",
                        {
                            "candidates": [target_qn],
                            "reason": "imported module symbol; Python name binding is dynamic, "
                                      "so no definitive resolution was made",
                        },
                    )
                else:
                    finish(
                        "heuristic",
                        self.external_ref(target_qn),
                        f"CALLS: {owner_qn} → {target_qn} matched as an external symbol "
                        "based on the import statement (heuristic; no semantic verification).",
                        {
                            "candidates": [target_qn],
                            "reason": "import outside the analysis set; no semantic verification",
                        },
                    )
            else:
                finish(
                    "unresolved", self.external_ref(binding_name),
                    f"CALLS: {owner_qn} → {binding_name} could not be resolved (unresolved); "
                    "no fabricated target was produced.",
                )
            return

        # ("symbol", module_dotted, symbol_name)
        _, dotted_module, symbol_name = binding
        symbol_qn = f"{dotted_module}.{symbol_name}" if dotted_module else symbol_name
        registry_entry = self.collector.symbol_registry.get(symbol_qn)

        if registry_entry is not None:
            target_kind, target_relative_path = registry_entry
            if len(rest) == 1 and target_kind == "Class":
                class_members = self.collector.class_member_registry.get(symbol_qn, {})
                member = class_members.get(rest[0])
                if member is not None:
                    member_kind, member_qn, member_path = member
                    finish(
                        "heuristic",
                        {"kind": member_kind, "qualifiedName": member_qn,
                         "relativePath": member_path},
                        f"CALLS: {owner_qn} → {member_qn} resolved via the member table "
                        "of an imported class symbol (heuristic; no full type inference).",
                        {
                            "candidates": [member_qn],
                            "reason": "imported module symbol; Python name binding is dynamic, "
                                      "so no definitive resolution was made",
                        },
                    )
                    return
            finish(
                "heuristic",
                {"kind": target_kind, "qualifiedName": symbol_qn,
                 "relativePath": target_relative_path},
                f"CALLS: {owner_qn} → {symbol_qn} resolved through an imported "
                "module symbol (heuristic; no full type inference).",
                {
                    "candidates": [symbol_qn],
                    "reason": "imported module symbol; Python name binding is dynamic, "
                              "so no definitive resolution was made",
                },
            )
            return

        # Analiz seti dışı import sembolü: import bildirimi metinsel dayanaktır.
        external_qn = f"{symbol_qn}.{'.'.join(rest)}" if rest else symbol_qn
        finish(
            "heuristic",
            self.external_ref(external_qn),
            f"CALLS: {owner_qn} → {external_qn} matched as an external symbol "
            "based on the import statement (heuristic; no semantic verification).",
            {
                "candidates": [external_qn],
                "reason": "import outside the analysis set; no semantic verification",
            },
        )


class RequestCollector:
    """İstek düzeyi node/edge/evidence toplayıcı — deterministik çıktı için."""

    def __init__(self) -> None:
        self._nodes: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        self._edges: Dict[Tuple[str, str, str, str], Dict[str, Any]] = {}
        self._edge_order: List[Tuple[str, str, str, str]] = []
        self._evidence_keys: set = set()
        self.warnings: List[str] = []
        self.diagnostics: List[Dict[str, Any]] = []
        self.module_set: set = set()
        # qualified_name → (kind, relative_path)
        self.symbol_registry: Dict[str, Tuple[str, str]] = {}
        # class_qualified_name → {üye adı → (kind, qn, relative_path)}
        self.class_member_registry: Dict[str, Dict[str, Tuple[str, str, str]]] = {}

    def add_file_node(self, relative_path: str, source_hash: str) -> None:
        self.add_node("File", relative_path, relative_path,
                      attributes={"sourceHash": source_hash})

    def add_node(
        self,
        kind: str,
        qualified_name: str,
        relative_path: Optional[str],
        attributes: Optional[Dict[str, Any]] = None,
        span: Optional[Dict[str, int]] = None,
    ) -> None:
        key = (kind, qualified_name, relative_path or "")
        if key in self._nodes:
            widen_node_span(self._nodes[key], span)
            return
        node: Dict[str, Any] = {"kind": kind, "qualifiedName": qualified_name}
        node["language"] = "python"
        if relative_path is not None:
            node["relativePath"] = relative_path
        widen_node_span(node, span)
        node["attributes"] = attributes if attributes is not None else {}
        self._nodes[key] = node
        if kind == "File" and relative_path is not None:
            self.module_set.add(module_name_from_path(relative_path))

    def add_contains(self, parent_ref: Dict[str, Any], child_ref: Dict[str, Any],
                     evidence_item: Dict[str, Any]) -> None:
        self._add_edge("CONTAINS", parent_ref, child_ref, "verified", [evidence_item], None)

    def add_calls(
        self,
        caller_ref: Dict[str, Any],
        target_ref: Dict[str, Any],
        resolution: str,
        evidence_item: Dict[str, Any],
        ambiguity: Optional[Dict[str, Any]],
    ) -> None:
        self._add_edge("CALLS", caller_ref, target_ref, resolution, [evidence_item], ambiguity)

    def add_route(self, endpoint_ref: Dict[str, Any], handler_ref: Dict[str, Any],
                  evidence_item: Dict[str, Any]) -> None:
        self._add_edge("ROUTES_TO", endpoint_ref, handler_ref, "verified", [evidence_item], None)

    def register_symbol(self, qualified_name: str, kind: str, relative_path: str) -> None:
        self.symbol_registry[qualified_name] = (kind, relative_path)

    def register_class_members(self, class_qn: str,
                               members: Dict[str, Tuple[str, str, str]]) -> None:
        self.class_member_registry.setdefault(class_qn, {}).update(members)

    def add_warning(self, message: str) -> None:
        self.warnings.append(message)

    def add_diagnostic(self, relative_path: str, code: str, message: str, line: int) -> None:
        self.diagnostics.append(
            {"relativePath": relative_path, "code": code, "message": message, "line": line}
        )

    def _add_edge(
        self,
        kind: str,
        from_ref: Dict[str, Any],
        to_ref: Dict[str, Any],
        resolution: str,
        evidence_items: List[Dict[str, Any]],
        ambiguity: Optional[Dict[str, Any]],
    ) -> None:
        key = (kind, canonical(from_ref), canonical(to_ref), resolution)
        # TŞ §8 invariant (ii): dangling edge yok — dış kaynaklar AÇIK node.
        # UnknownExternal hedef ilk referans alındığında node kümesine girer.
        if to_ref.get("kind") == "UnknownExternal":
            self.add_node("UnknownExternal", to_ref["qualifiedName"], None)
        edge = self._edges.get(key)
        if edge is None:
            edge = {"kind": kind, "from": from_ref, "to": to_ref, "resolution": resolution}
            edge["evidence"] = []
            if ambiguity is not None:
                edge["ambiguity"] = ambiguity
            self._edges[key] = edge
            self._edge_order.append(key)
        for item in evidence_items:
            evidence_key = canonical(item)
            self._evidence_keys.add(evidence_key)
            if all(canonical(existing) != evidence_key for existing in edge["evidence"]):
                edge["evidence"].append(item)

    # -- çıktı ---------------------------------------------------------------------

    def response(self, request_id: Any, max_nodes: Optional[int]) -> Dict[str, Any]:
        nodes = sorted(
            self._nodes.values(),
            key=lambda node: (node["kind"], node["qualifiedName"],
                              node.get("relativePath") or ""),
        )
        edges = sorted(
            (self._edges[key] for key in self._edge_order),
            key=lambda edge: (
                edge["kind"],
                edge["from"]["kind"],
                edge["from"]["qualifiedName"],
                edge["from"].get("relativePath") or "",
                edge["to"]["kind"],
                edge["to"]["qualifiedName"],
                edge["to"].get("relativePath") or "",
                edge["resolution"],
            ),
        )

        diagnostics = list(self.diagnostics)

        if max_nodes is not None and len(nodes) > max_nodes:
            kept = nodes[:max_nodes]
            kept_keys = {
                (node["kind"], node["qualifiedName"], node.get("relativePath") or "")
                for node in kept
            }
            edges = [
                edge for edge in edges
                if (edge["from"]["kind"], edge["from"]["qualifiedName"],
                    edge["from"].get("relativePath") or "") in kept_keys
                and (edge["to"]["kind"], edge["to"]["qualifiedName"],
                     edge["to"].get("relativePath") or "") in kept_keys
            ]
            nodes = kept
            diagnostics.append(
                {
                    "relativePath": "",
                    "code": "RESPONSE_TRUNCATED",
                    "message": f"node budget exceeded: {max_nodes} nodes published; "
                               "the excess nodes and the edges whose endpoints were "
                               "not published were dropped",
                    "line": 0,
                }
            )

        # Üst düzey evidence: yayımlanan kenarların kanıt kümesi (tekil, sıralı).
        evidence: Dict[str, Dict[str, Any]] = {}
        for edge in edges:
            for item in edge["evidence"]:
                evidence.setdefault(canonical(item), item)
        evidence_list = [evidence[key] for key in sorted(evidence.keys())]

        # Çıkışta sert doğrulama: worker liste dışı tür üretemez.
        for node in nodes:
            if node["kind"] not in NODE_KINDS:
                raise ValueError(f"node kind outside the catalog: {node['kind']}")
        for edge in edges:
            if edge["kind"] not in EDGE_KINDS or edge["resolution"] not in RESOLUTIONS:
                raise ValueError("edge kind or resolution outside the catalog")
        for item in evidence_list:
            if item["kind"] not in EVIDENCE_KINDS:
                raise ValueError(f"evidence kind outside the catalog: {item['kind']}")

        total_edges = len(edges)
        verified_edges = sum(1 for edge in edges if edge["resolution"] == "verified")
        coverage = round(verified_edges / total_edges, 4) if total_edges > 0 else 1.0

        response: Dict[str, Any] = {
            "id": request_id,
            "protocolVersion": PROTOCOL_VERSION,
            "status": "partial" if diagnostics else "ready",
            "worker": {"analyzerId": ANALYZER_ID, "analyzerVersion": ANALYZER_VERSION},
            "capabilities": {
                "astParse": True,
                "symbolResolution": True,
                "containsEdges": True,
                "callEdges": True,
                "importEdges": False,
                "routeDetection": "python-decorator-route-pattern",
                "frameworkLinkers": False,
            },
            "coverageRatio": coverage,
            "unsupportedConstructs": list(UNSUPPORTED_CONSTRUCTS),
            "warnings": list(self.warnings),
            "diagnostics": diagnostics,
            "nodes": nodes,
            "edges": edges,
            "evidence": evidence_list,
        }
        return response


# ---------------------------------------------------------------------------
# Ana döngü
# ---------------------------------------------------------------------------

def analyze_request(request: Dict[str, Any]) -> Dict[str, Any]:
    collector = RequestCollector()

    # Ayrıştırma: sözdizimi hatası HATA DEĞİLDİR → tanı + File node (L0),
    # diğer dosyaların grafiği üretilmeye devam eder (status: partial).
    analyzers: List[FileAnalyzer] = []
    for entry in request["files"]:
        relative_path = entry["path"]
        content = entry["content"]
        try:
            tree = ast.parse(content, filename=relative_path)
        except SyntaxError as error:
            collector.add_diagnostic(
                relative_path,
                "SyntaxError",
                str(error.msg or "syntax error"),
                error.lineno or 0,
            )
            collector.add_file_node(relative_path, sha256_hex(content))
            continue
        except (RecursionError, MemoryError, ValueError) as error:
            collector.add_diagnostic(
                relative_path,
                "ADAPTER_INTERNAL",
                f"AST parsing could not be completed: {error}",
                0,
            )
            collector.add_file_node(relative_path, sha256_hex(content))
            continue
        analyzers.append(FileAnalyzer(relative_path, content, tree, collector))

    # Geçiş 1: bildirimler (File/Function/Method/Class/Endpoint + CONTAINS
    # + ROUTES_TO) ve global sembol kaydı.
    for analyzer in analyzers:
        analyzer.analyze()

    # Geçiş 2: çağrı çözümleme (tüm modüllerin sembolleri kayıtlı olduktan sonra;
    # çok dosyalı import zincirleri doğru hedefe bağlanır).
    for analyzer in analyzers:
        analyzer.resolve_calls()

    # Limits of both passes are reported once per file.
    for analyzer in analyzers:
        if analyzer.depth_exceeded:
            collector.add_diagnostic(
                analyzer.path,
                "ADAPTER_INTERNAL",
                f"AST traversal depth {MAX_AST_DEPTH} exceeded; deeper subtrees were skipped",
                0,
            )
        if analyzer.recursion_exceeded:
            collector.add_diagnostic(
                analyzer.path,
                "ADAPTER_INTERNAL",
                "AST traversal exceeded the interpreter recursion budget; "
                "the declarations and calls of this file are partial",
                0,
            )

    return collector.response(request["id"], request.get("maxNodes"))


def handle_line(line: str) -> Dict[str, Any]:
    try:
        payload = json.loads(line)
    except (ValueError, RecursionError) as error:
        # RecursionError da yakalanır (takım denetimi bulgusu): çok derin
        # iç içe JSON (ör. 5000 katman dizi) decoder'da RecursionError
        # fırlatır; yakalanmazsa süreci öldürür ve 'bozuk satır döngüyü
        # düşürmez' sözleşmesi ihlal olur (tests/python-worker.test.ts
        # 'derin iç içe JSON satırı' regresyon testi).
        return error_response(None, "INVALID_ARGUMENT", f"line is not valid JSON: {error}")

    request, error = validate_request(payload)
    if error is not None:
        return error

    try:
        return analyze_request(request)
    except Exception as unexpected:  # noqa: BLE001 — döngü yaşamaya devam eder
        log(f"unexpected analysis error: {unexpected!r}")
        return error_response(
            request["id"],
            "INTERNAL_ERROR",
            f"analysis failed with an unexpected error: {type(unexpected).__name__}",
        )


def write_response(stdout_buf: Any, response: Dict[str, Any]) -> None:
    line = json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n"
    stdout_buf.write(line.encode("utf-8"))
    stdout_buf.flush()


def read_line(stream: Any) -> Tuple[Optional[bytes], bool, bool]:
    """(satır, sınır_aşıldı, eof) döner. Aşan satır DISCARD edilir (yanıt yine yazılır)."""
    cap = MAX_REQUEST_LINE_BYTES + 1
    chunk = stream.readline(cap)
    if not chunk:
        return None, False, True
    if chunk.endswith(b"\n"):
        return chunk[:-1], False, False
    if len(chunk) > MAX_REQUEST_LINE_BYTES:
        while True:
            rest = stream.readline(cap)
            if not rest or rest.endswith(b"\n"):
                break
        return None, True, False
    return chunk, False, False  # EOF'ta \n'siz son satır


def main() -> int:
    stdin_buf = sys.stdin.buffer
    stdout_buf = sys.stdout.buffer

    log(f"worker started — protocol v{PROTOCOL_VERSION}, analyzer {ANALYZER_ID} v{ANALYZER_VERSION}")

    try:
        while True:
            line, exceeded, eof = read_line(stdin_buf)
            if exceeded:
                write_response(
                    stdout_buf,
                    error_response(
                        None,
                        "LIMIT_EXCEEDED",
                        f"request line exceeded the {MAX_REQUEST_LINE_BYTES} byte limit; line skipped",
                    ),
                )
                log("request line limit exceeded — line skipped")
                continue
            if line is None or eof:
                break  # EOF
            if not line.strip():
                continue  # boş satır sessizce atlanır (mesaj tek satır JSON)

            try:
                text = line.decode("utf-8")
            except UnicodeDecodeError as error:
                write_response(
                    stdout_buf,
                    error_response(None, "INVALID_ARGUMENT", f"line is not valid UTF-8: {error}"),
                )
                continue

            response = handle_line(text)
            write_response(stdout_buf, response)
            log(f"request processed: id={describe_id(response.get('id'))} status={response.get('status')}")
    except (BrokenPipeError, OSError) as error:
        log(f"stdio pipe error, worker exiting: {error}")
        return 1

    log("EOF — worker exiting normally")
    return 0


# ---------------------------------------------------------------------------
# Node spans (PROTOCOL.md "Node fields": optional `span`)
# ---------------------------------------------------------------------------

def declaration_span(statement: ast.AST) -> Optional[Dict[str, int]]:
    """1-based, inclusive declaration lines of a def/class statement
    (``lineno``..``end_lineno``; decorators are outside the range since
    Python 3.8). None when the AST carries no usable positions."""
    start = getattr(statement, "lineno", None)
    end = getattr(statement, "end_lineno", None)
    if not isinstance(start, int) or not isinstance(end, int) or start < 1 or end < start:
        return None
    return {"startLine": start, "endLine": end}


def widen_node_span(node: Dict[str, Any], span: Optional[Dict[str, int]]) -> None:
    """Records `span` on `node`. A node declared more than once (a property
    getter and its setter, a redefined function) gets the smallest range that
    covers every declaration, so the result does not depend on visit order."""
    if span is None:
        return
    current = node.get("span")
    if current is None:
        node["span"] = dict(span)
        return
    node["span"] = {
        "startLine": min(current["startLine"], span["startLine"]),
        "endLine": max(current["endLine"], span["endLine"]),
    }


if __name__ == "__main__":
    sys.exit(main())
