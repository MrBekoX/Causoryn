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

# Budgets for rendering long expressions: source bytes of every rendered
# expression longer than MAX_RENDERED_EXPRESSION_CHARS (ast.unparse or its
# source-segment fallback, and the digest of the result; ast.unparse visits at
# most one node per source byte). Past either budget such an expression is
# named by its source range instead, so nested or chained long expressions
# cannot make rendering quadratic. Real code stays far below both: 35,460
# files of CPython's Lib (site-packages included) render 222 KB in total,
# at most 8.6 KB in one file.
MAX_RENDER_SOURCE_BYTES_PER_FILE = 256_000
MAX_RENDER_SOURCE_BYTES_PER_REQUEST = 1_000_000

# Line splitting of ast.get_source_segment (ast._splitlines_no_ff): \r\n, \n
# and \r end a line; form feeds and other characters do not.
_SOURCE_LINE = re.compile(r"(.*?(?:\r\n|\n|\r|$))")

# ast.unparse enters every child through _Unparser.traverse, NodeVisitor.visit
# and the node's visit_<Kind> method: at least three frames per nesting level.
_UNPARSE_FRAMES_PER_LEVEL = 3


def _spine_depth(node: ast.AST, cap: int) -> int:
    """Length of the call/attribute/subscript chain below `node` (following
    Call.func, Attribute.value and Subscript.value), counted up to `cap`: a
    lower bound of the node's nesting depth, found without recursion."""
    depth = 1
    current = node
    while depth <= cap:
        if isinstance(current, ast.Call):
            current = current.func
        elif isinstance(current, (ast.Attribute, ast.Subscript)):
            current = current.value
        else:
            break
        depth += 1
    return depth

# Upper bound for declared qualified names and literal route paths (import-
# derived UnknownExternal names use the expression bound above). Without it
# one long identifier is copied into every edge endpoint, rationale and key
# that quotes it.
MAX_QUALIFIED_NAME_CHARS = 512

# Upper bound for the distinct entries of a route decorator's methods list;
# each entry becomes one Endpoint carrying the route path.
MAX_ROUTE_METHODS = 16

# Response size budget: UTF-8 bytes of the serialized nodes, edges, evidence
# (counted twice: in its edge and in the top-level list) and warnings. Once it
# is spent nothing more is admitted, edges never dangle, and the response gets
# a RESPONSE_TRUNCATED diagnostic (status "partial"). It stays below the
# adapter's default response line cap (64 MiB characters).
MAX_RESPONSE_BYTES = 40_000_000

# A response line longer than this (only reachable through diagnostics on top
# of a spent budget) is replaced by a LIMIT_EXCEEDED error line.
MAX_RESPONSE_LINE_BYTES = 60_000_000

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
            # backslashreplace: a lone surrogate in a log line is escaped
            # instead of raising (reconfigure would otherwise reset to strict).
            reconfigure(encoding="utf-8", errors="backslashreplace")
        except (OSError, ValueError):
            pass  # reconfigure desteklenmiyorsa binary stdout disiplini yine sağlamdır


_force_utf8_stderr()


def canonical(value: Any) -> str:
    """Kanonik JSON dizesi — deterministik sıralama/dedupe anahtarı."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def utf8_size(text: str) -> int:
    """UTF-8 byte length of serialized text (the length the response line has)."""
    return len(text.encode("utf-8", "surrogatepass"))


def sha256_hex(content: str) -> str:
    """UTF-8 SHA-256 — domain sha256Hex(utf8Encode(content)) ile bit-bit aynı."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def bounded_text(text: str, limit: int = MAX_RENDERED_EXPRESSION_CHARS) -> str:
    """Caps text at `limit` characters (default MAX_RENDERED_EXPRESSION_CHARS)
    plus a digest suffix, so distinct texts stay distinct."""
    if len(text) <= limit:
        return text
    digest = hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()[:12]
    return f"{text[:limit]}...#{digest}"


def bounded_name(text: str) -> str:
    """Caps a qualified name or name-like text at MAX_QUALIFIED_NAME_CHARS."""
    return bounded_text(text, MAX_QUALIFIED_NAME_CHARS)


def is_utf8_text(text: str) -> bool:
    """False when `text` holds a lone surrogate (it cannot be encoded as UTF-8)."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def escape_lone_surrogates(text: str) -> str:
    """Replaces each lone surrogate with its `\\uXXXX` escape text.

    Python accepts `"\\ud800"` in a str literal; such a character cannot be
    encoded as UTF-8, so it must never reach the response. The escape is
    deterministic; text without lone surrogates is returned unchanged.
    """
    if is_utf8_text(text):
        return text
    return text.encode("utf-8", "backslashreplace").decode("utf-8")


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
    if not is_utf8_text(raw):
        # The path is not quoted: a lone surrogate cannot be written to stdout.
        return None, "files[].path must be valid Unicode text (it contains a lone surrogate)"
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
    if isinstance(raw_id, str) and not is_utf8_text(raw_id):
        # The id cannot be echoed: a lone surrogate cannot be written to stdout.
        return None, error_response(
            None, "INVALID_ARGUMENT", "id must be valid Unicode text (it contains a lone surrogate)"
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
        try:
            content_bytes = len(content.encode("utf-8"))
        except UnicodeEncodeError:
            return None, error_response(
                echoed_id,
                "INVALID_ARGUMENT",
                f"files[{index}].content must be valid Unicode text (it contains a lone surrogate)",
            )
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
        # Source lines, their UTF-8 forms and byte offsets: split once per file
        # (on first use) instead of on every source-segment fallback.
        self._source_lines: Optional[List[str]] = None
        self._line_bytes: Dict[int, bytes] = {}
        self._line_byte_starts: Optional[List[int]] = None
        self._render_bytes_left = MAX_RENDER_SOURCE_BYTES_PER_FILE
        # Call-walk depth of the call being resolved (0 outside the walk).
        self._walk_depth = 0

    # -- yardımcılar ----------------------------------------------------------

    def file_ref(self) -> Dict[str, Any]:
        return {"kind": "File", "qualifiedName": self.path, "relativePath": self.path}

    def ref(self, kind: str, qualified_name: str) -> Dict[str, Any]:
        return {"kind": kind, "qualifiedName": qualified_name, "relativePath": self.path}

    def external_ref(self, qualified_name: str) -> Dict[str, Any]:
        """Dış/çözümsüz hedef: dosya taşımaz (analiz seti dışı sembol)."""
        return {"kind": "UnknownExternal", "qualifiedName": bounded_text(qualified_name)}

    def render(self, node: ast.AST) -> str:
        """Bounded `ast.unparse` rendering of an expression of this file.

        ast.unparse is recursive: an expression too deep to render falls back to
        its source segment, or to a positional placeholder. An expression whose
        source is longer than MAX_RENDERED_EXPRESSION_CHARS bytes is charged at
        its source size against the file's and the request's render budgets;
        once either is spent it is named by its source range (`<expression at
        path:line:col..end_line:end_col>`, distinct per expression) instead.
        """
        size = self._source_size(node)
        if size is not None and size > MAX_RENDERED_EXPRESSION_CHARS:
            collector = self.collector
            if size > self._render_bytes_left or size > collector.render_bytes_left:
                # Sticky for the file (and for the request once it is spent),
                # so the cut is deterministic.
                self._render_bytes_left = 0
                if size > collector.render_bytes_left:
                    collector.render_bytes_left = 0
                return bounded_text(
                    f"<expression at {self.path}:{node.lineno}:{node.col_offset}"
                    f"..{node.end_lineno}:{node.end_col_offset}>"
                )
            self._render_bytes_left -= size
            collector.render_bytes_left -= size
        try:
            free_frames = sys.getrecursionlimit() - self._walk_depth
            spine_cap = free_frames // _UNPARSE_FRAMES_PER_LEVEL + 1
            if _UNPARSE_FRAMES_PER_LEVEL * _spine_depth(node, spine_cap) > free_frames:
                # ast.unparse would certainly raise RecursionError here (it
                # uses at least three frames per nesting level, and at least
                # _walk_depth frames are in use); skip the doomed attempt,
                # whose unwinding costs about a millisecond per call.
                raise RecursionError
            return bounded_text(ast.unparse(node))
        except (RecursionError, ValueError):
            segment = None
            try:
                segment = self.source_segment(node)
            except (RecursionError, ValueError, IndexError):
                segment = None
            if segment:
                return bounded_text(segment)
            line = getattr(node, "lineno", 0)
            column = getattr(node, "col_offset", 0)
            return f"<expression at {line}:{column}>"

    def _release_source_lines(self) -> None:
        """Drops the line caches at the end of a pass (rebuilt on demand)."""
        self._source_lines = None
        self._line_bytes = {}
        self._line_byte_starts = None

    def _lines(self) -> List[str]:
        if self._source_lines is None:
            self._source_lines = [match[0] for match in _SOURCE_LINE.finditer(self.content)]
        return self._source_lines

    def _encoded_line(self, index: int) -> bytes:
        encoded = self._line_bytes.get(index)
        if encoded is None:
            encoded = self._lines()[index].encode("utf-8")
            self._line_bytes[index] = encoded
        return encoded

    def _source_size(self, node: ast.AST) -> Optional[int]:
        """UTF-8 byte length of the source of `node`; None without positions."""
        lineno = getattr(node, "lineno", None)
        end_lineno = getattr(node, "end_lineno", None)
        col_offset = getattr(node, "col_offset", None)
        end_col_offset = getattr(node, "end_col_offset", None)
        if None in (lineno, end_lineno, col_offset, end_col_offset):
            return None
        if self._line_byte_starts is None:
            starts = [0]
            for line in self._lines():
                starts.append(starts[-1] + len(line.encode("utf-8")))
            self._line_byte_starts = starts
        starts = self._line_byte_starts
        if not (1 <= lineno <= end_lineno < len(starts)):
            return None
        return (starts[end_lineno - 1] + end_col_offset) - (starts[lineno - 1] + col_offset)

    def source_segment(self, node: ast.AST) -> Optional[str]:
        """ast.get_source_segment(self.content, node) (padded=False), with the
        file split into lines once instead of once per call."""
        try:
            if node.end_lineno is None or node.end_col_offset is None:
                return None
            lineno = node.lineno - 1
            end_lineno = node.end_lineno - 1
            col_offset = node.col_offset
            end_col_offset = node.end_col_offset
        except AttributeError:
            return None
        if end_lineno == lineno:
            return self._encoded_line(lineno)[col_offset:end_col_offset].decode()
        first = self._encoded_line(lineno)[col_offset:].decode()
        last = self._encoded_line(end_lineno)[:end_col_offset].decode()
        return "".join([first, *self._lines()[lineno + 1:end_lineno], last])

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
        self._release_source_lines()

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
            # Bounded once here (CPython has no identifier length limit); the
            # name tables below keep the raw name as the lookup key.
            qualified = bounded_name(f"{prefix}.{name}")
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
            qualified = bounded_name(f"{prefix}.{name}")
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

            decorator_label = bounded_text(f"{carrier}.{attr}")
            if path is None:
                self.collector.add_warning(
                    f"{self.path}: the route path of decorator '{decorator_label}' is not a "
                    f"literal string; no endpoint was produced for {handler_qn}"
                )
                continue
            # The literal path is copied into every Endpoint of the decorator:
            # escape lone surrogates (they cannot be written as UTF-8) and bound it.
            path = bounded_name(escape_lone_surrogates(path))
            if len(verbs) > MAX_ROUTE_METHODS:
                self.collector.add_warning(
                    f"{self.path}: the methods list of decorator '{decorator_label}' on "
                    f"{handler_qn} has {len(verbs)} distinct entries; only the first "
                    f"{MAX_ROUTE_METHODS} were used"
                )
                verbs = verbs[:MAX_ROUTE_METHODS]

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
        """Distinct methods of a `methods=[...]` list, in source order (each one
        escaped and bounded like the path)."""
        for keyword in call.keywords:
            if keyword.arg == "methods" and isinstance(keyword.value, ast.List):
                verbs: List[str] = []
                seen: set = set()
                for element in keyword.value.elts:
                    if isinstance(element, ast.Constant) and isinstance(element.value, str):
                        verb = bounded_text(escape_lone_surrogates(element.value.strip().upper()))
                        if verb and verb not in seen:
                            seen.add(verb)
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
        try:
            for node, kind, qualified, class_qn in self.callables:
                if self.collector.budget_exceeded:
                    return  # nothing more can be admitted
                try:
                    for statement in node.body:
                        self._walk_calls(statement, (kind, qualified, class_qn), depth=1)
                except RecursionError:
                    # Isolated per callable: its remaining calls are skipped.
                    self.recursion_exceeded = True
        finally:
            self._release_source_lines()

    def _walk_calls(
        self,
        statement: ast.AST,
        owner: Tuple[str, str, Optional[str]],
        depth: int,
    ) -> None:
        if depth > MAX_AST_DEPTH:
            self.depth_exceeded = True
            return
        if self.collector.budget_exceeded:
            return  # nothing more can be admitted

        if isinstance(statement, ast.Call):
            # Each walk level is one Python frame: renders of this call know
            # at least this many frames are in use (see render).
            self._walk_depth = depth
            self._resolve_call(statement, owner)
            self._walk_depth = 0

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
                    f"CALLS: {owner_qn} → {bounded_text(name)} could not be resolved (unresolved); "
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
                        f"CALLS: {owner_qn} → {member[1]} resolved 'self.{bounded_text(rest[0])}' via the "
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
                    # The import name is written once but quoted by every call:
                    # the rationale and candidate use the bounded node name.
                    external = self.external_ref(target_qn)
                    shown = external["qualifiedName"]
                    finish(
                        "heuristic",
                        external,
                        f"CALLS: {owner_qn} → {shown} matched as an external symbol "
                        "based on the import statement (heuristic; no semantic verification).",
                        {
                            "candidates": [shown],
                            "reason": "import outside the analysis set; no semantic verification",
                        },
                    )
            else:
                finish(
                    "unresolved", self.external_ref(binding_name),
                    f"CALLS: {owner_qn} → {bounded_text(binding_name)} could not be resolved (unresolved); "
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
        external = self.external_ref(external_qn)
        shown = external["qualifiedName"]
        finish(
            "heuristic",
            external,
            f"CALLS: {owner_qn} → {shown} matched as an external symbol "
            "based on the import statement (heuristic; no semantic verification).",
            {
                "candidates": [shown],
                "reason": "import outside the analysis set; no semantic verification",
            },
        )


class RequestCollector:
    """İstek düzeyi node/edge/evidence toplayıcı — deterministik çıktı için."""

    def __init__(self) -> None:
        self._nodes: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        self._edges: Dict[Tuple[str, str, str, str], Dict[str, Any]] = {}
        self._edge_order: List[Tuple[str, str, str, str]] = []
        # Canonical keys of each edge's evidence: merging is a set lookup
        # instead of re-serializing the edge's whole evidence list per call.
        self._edge_evidence_keys: Dict[Tuple[str, str, str, str], set] = {}
        self.warnings: List[str] = []
        self.diagnostics: List[Dict[str, Any]] = []
        self.module_set: set = set()
        # qualified_name → (kind, relative_path)
        self.symbol_registry: Dict[str, Tuple[str, str]] = {}
        # class_qualified_name → {üye adı → (kind, qn, relative_path)}
        self.class_member_registry: Dict[str, Dict[str, Tuple[str, str, str]]] = {}
        # Long-expression render budget of the request (FileAnalyzer.render).
        self.render_bytes_left = MAX_RENDER_SOURCE_BYTES_PER_REQUEST
        # Response size budget (MAX_RESPONSE_BYTES): serialized bytes admitted so far.
        self._budget_used = 0
        self.budget_exceeded = False
        self._warnings_suppressed = False

    def _charge(self, size: int) -> bool:
        """Admits `size` more bytes. Once a charge fails nothing more is
        admitted (sticky), so the cut does not depend on later record sizes."""
        if self.budget_exceeded or self._budget_used + size > MAX_RESPONSE_BYTES:
            self.budget_exceeded = True
            return False
        self._budget_used += size
        return True

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
        size = utf8_size(canonical(node)) + 1
        if kind == "File":
            # One File node per file (bounded by MAX_FILE_COUNT): always admitted.
            self._budget_used += size
        elif not self._charge(size):
            return
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
        if not self._charge(utf8_size(canonical(message)) + 1):
            if not self._warnings_suppressed:
                self._warnings_suppressed = True
                self.warnings.append("further warnings were not emitted: the response size budget was reached")
            return
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
        edge = self._edges.get(key)
        if edge is not None:
            seen = self._edge_evidence_keys[key]
            for item in evidence_items:
                evidence_key = canonical(item)
                if evidence_key in seen:
                    continue
                # Charged twice: the edge's list and the top-level evidence list.
                if not self._charge(2 * (utf8_size(evidence_key) + 1)):
                    return  # the edge keeps the evidence it already has
                seen.add(evidence_key)
                edge["evidence"].append(item)
            return
        if self.budget_exceeded:
            return
        # TŞ §8 invariant (ii): dangling edge yok — dış kaynaklar AÇIK node.
        # UnknownExternal hedef ilk referans alındığında node kümesine girer.
        if to_ref.get("kind") == "UnknownExternal":
            self.add_node("UnknownExternal", to_ref["qualifiedName"], None)
        for ref in (from_ref, to_ref):
            if (ref["kind"], ref["qualifiedName"], ref.get("relativePath") or "") not in self._nodes:
                return  # endpoint not admitted (size budget): no dangling edge
        edge = {"kind": kind, "from": from_ref, "to": to_ref, "resolution": resolution}
        edge["evidence"] = []
        if ambiguity is not None:
            edge["ambiguity"] = ambiguity
        size = utf8_size(canonical(edge)) + 1
        seen: set = set()
        admitted: List[Dict[str, Any]] = []
        for item in evidence_items:
            evidence_key = canonical(item)
            if evidence_key not in seen:
                seen.add(evidence_key)
                admitted.append(item)
                size += 2 * (utf8_size(evidence_key) + 1)
        if not self._charge(size):
            return
        edge["evidence"].extend(admitted)
        self._edges[key] = edge
        self._edge_order.append(key)
        self._edge_evidence_keys[key] = seen

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
        if self.budget_exceeded:
            diagnostics.append(
                {
                    "relativePath": "",
                    "code": "RESPONSE_TRUNCATED",
                    "message": f"response size budget exceeded ({MAX_RESPONSE_BYTES} bytes of nodes, "
                               "edges, evidence and warnings); further nodes, edges, evidence and "
                               "warnings were not emitted (no dangling edges)",
                    "line": 0,
                }
            )

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
            # A parser message can quote an identifier of any length.
            collector.add_diagnostic(
                relative_path,
                "SyntaxError",
                bounded_text(str(error.msg or "syntax error")),
                error.lineno or 0,
            )
            collector.add_file_node(relative_path, sha256_hex(content))
            continue
        except (RecursionError, MemoryError, ValueError) as error:
            collector.add_diagnostic(
                relative_path,
                "ADAPTER_INTERNAL",
                f"AST parsing could not be completed: {bounded_text(str(error))}",
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


# Last-resort protocol line: pure ASCII and built without json at runtime.
_FALLBACK_ERROR_LINE = (
    b'{"id":null,"protocolVersion":"1","status":"error","error":'
    b'{"code":"INTERNAL_ERROR","message":"the response could not be serialized"}}\n'
)


def _echoable_id(value: Any) -> Any:
    """`value` when it can be echoed in an error line, otherwise None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and is_utf8_text(value):
        return value
    return None


def error_line(request_id: Any, code: str, message: str) -> bytes:
    """An error response line; the fixed ASCII line if even that fails."""
    try:
        response = error_response(_echoable_id(request_id), code, message)
        return (json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    except Exception:  # noqa: BLE001 — the process must still answer
        return _FALLBACK_ERROR_LINE


def encode_response(response: Dict[str, Any]) -> bytes:
    """One protocol line as UTF-8 bytes. Never raises.

    A response that cannot be serialized (a lone surrogate cannot be encoded
    as UTF-8; MemoryError, RecursionError, ...) is replaced by an
    INTERNAL_ERROR line with a fixed message, and a line longer than
    MAX_RESPONSE_LINE_BYTES by a LIMIT_EXCEEDED line; both echo the request id
    when it can be encoded. Nothing is raised, so no traceback reaches stderr.
    """
    try:
        encoded = (json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    except UnicodeEncodeError:
        log("the response could not be encoded as UTF-8 (lone surrogate); an INTERNAL_ERROR line is written instead")
        return error_line(
            response.get("id"),
            "INTERNAL_ERROR",
            "the response could not be encoded as UTF-8 (it contains a lone surrogate)",
        )
    except Exception as error:  # noqa: BLE001 — MemoryError, RecursionError, ...
        log(f"the response could not be serialized ({type(error).__name__}); an INTERNAL_ERROR line is written instead")
        return error_line(response.get("id"), "INTERNAL_ERROR", "the response could not be serialized")
    if len(encoded) > MAX_RESPONSE_LINE_BYTES:
        log(f"the response line of {len(encoded)} bytes exceeds the {MAX_RESPONSE_LINE_BYTES} byte limit")
        return error_line(
            response.get("id"),
            "LIMIT_EXCEEDED",
            f"response line exceeded the {MAX_RESPONSE_LINE_BYTES} byte limit",
        )
    return encoded


def answer_request(line: bytes) -> Tuple[bytes, Any, Any]:
    """The response line for one request line, plus its id and status for the
    log. Never raises: an unexpected failure becomes an INTERNAL_ERROR line
    with a fixed message (no traceback)."""
    request_id: Any = None
    try:
        try:
            text = line.decode("utf-8")
        except UnicodeDecodeError as error:
            return (
                encode_response(error_response(None, "INVALID_ARGUMENT", f"line is not valid UTF-8: {error}")),
                None,
                "error",
            )
        response = handle_line(text)
        request_id = response.get("id")
        return encode_response(response), request_id, response.get("status")
    except Exception as error:  # noqa: BLE001 — the loop keeps running
        log(f"the request could not be answered ({type(error).__name__}); an INTERNAL_ERROR line is written instead")
        return error_line(request_id, "INTERNAL_ERROR", "the request could not be answered"), request_id, "error"


def _quiet_excepthook(exc_type: Any, exc_value: Any, exc_traceback: Any) -> None:
    """An uncaught error ends the worker with one log line naming its type.

    No traceback is printed: its file paths (install directory, user name)
    would reach tool warnings through the adapters' stderr excerpts.
    """
    try:
        log(f"worker stopped by an unexpected error ({exc_type.__name__})")
    except Exception:  # noqa: BLE001 — stderr itself may be gone
        pass


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
    sys.excepthook = _quiet_excepthook
    stdin_buf = sys.stdin.buffer
    stdout_buf = sys.stdout.buffer

    log(f"worker started — protocol v{PROTOCOL_VERSION}, analyzer {ANALYZER_ID} v{ANALYZER_VERSION}")

    try:
        while True:
            line, exceeded, eof = read_line(stdin_buf)
            if exceeded:
                stdout_buf.write(
                    error_line(
                        None,
                        "LIMIT_EXCEEDED",
                        f"request line exceeded the {MAX_REQUEST_LINE_BYTES} byte limit; line skipped",
                    )
                )
                stdout_buf.flush()
                log("request line limit exceeded — line skipped")
                continue
            if line is None or eof:
                break  # EOF
            if not line.strip():
                continue  # boş satır sessizce atlanır (mesaj tek satır JSON)

            payload, request_id, status = answer_request(line)
            stdout_buf.write(payload)
            stdout_buf.flush()
            log(f"request processed: id={describe_id(request_id)} status={status}")
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
