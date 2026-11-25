import path from "node:path";

import { z } from "zod";

import { findWindowsUnsafePathSegment, isWindowsDriveAbsolutePath } from "./path-safety.js";
import type { PolicyErrorCode } from "./policy-error.js";

const IS_WIN = process.platform === "win32";

/**
 * Workspace policy konfigürasyon şeması — TŞ v2.1 §20'deki `causoryn.config`
 * örneğinin workspace dilimi. Varsayılanlar güvenlidir: `allowRoots: []`
 * (explicit authorization, default deny) ve TŞ §20'deki default ignore
 * listesi bire bir korunur.
 */

/** TŞ §20 workspace.ignore default listesi + gerçek-dünya derleme/sanal-ortam/önbellek dizinleri. */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  "**/.git/**",
  "**/node_modules/**",
  "**/bin/**",
  "**/obj/**",
  "**/dist/**",
  "**/.env*",
  "**/*.pem",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.svelte-kit/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/.pytest_cache/**",
  "**/.mypy_cache/**",
  "**/.ruff_cache/**",
  "**/target/**",
  "**/coverage/**",
  "**/.vs/**",
  "**/.dotnet/**",
  "**/.dotnet-home/**",
  "**/.codex-build/**",
  "**/vendor/**",
  "**/Pods/**",
  "**/.gradle/**",
  "**/.angular/**",
  "**/.expo/**",
  "**/.idea/**",
  "**/.dart_tool/**",
  "**/.terraform/**",
  "**/.tox/**",
  "**/.nox/**",
  "**/.parcel-cache/**",
  "**/.vite/**",
  "**/*.min.js",
  "**/*.min.mjs",
];

/** Binary (metin olmayan) uzantı default kara listesi; politika lower-case karşılaştırır. */
export const DEFAULT_BINARY_EXTENSIONS: readonly string[] = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".bmp",
  ".webp",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".o",
  ".obj",
  ".a",
  ".lib",
  ".class",
  ".jar",
  ".pyc",
  ".wasm",
  ".nupkg",
  ".snupkg",
  ".pdb",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".wav",
  ".flac",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  ".sqlite",
  ".db",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".map",
  ".pyo",
  ".whl",
  ".egg",
  ".dmg",
  ".pkg",
  ".deb",
  ".rpm",
  ".iso",
  ".parquet",
  ".feather",
  ".arrow",
  ".h5",
  ".onnx",
  ".pt",
  ".pth",
  ".safetensors",
  ".ckpt",
  ".tflite",
  ".gguf",
];

/** TŞ §20 index.maxFileBytes default değeri. */
export const DEFAULT_MAX_FILE_BYTES = 2_000_000;

/**
 * Uzantı biçimi: nokta ile başlar; ".ts" tek segment olduğu gibi ".d.ts",
 * ".min.js" gibi çok segmentli uzantılar da geçerlidir (yorum-şema
 * uyuşmazlığı giderildi). Sondaki/art arda nokta reddedilir. Not:
 * checkFile eşlemesi `path.extname` (son segment) üzerinden yapılır; çok
 * segmentli girişler tam sonek eşlemesi isteyen tüketiciler içindir.
 */
const extensionSchema = z
  .string()
  .regex(/^\.(?:[A-Za-z0-9]+\.)*[A-Za-z0-9]+$/, "extension must have the form '.x' or '.a.b'")
  .transform((value) => value.toLowerCase());

/** Null byte içeren herhangi bir yol/desen girdisi reddedilir (OWASP %00 bypass). */
const noNullByte = (label: string) =>
  z
    .string()
    .min(1, `${label} must not be empty`)
    .refine((value) => !value.includes("\0"), `${label} must not contain a null byte`);

export const workspacePolicyConfigSchema = z.strictObject({
  /**
   * Kullanıcı tarafından açıkça beyan edilen kök dizinler (TŞ §20: CLI /
   * user-approval ile yönetilir; MCP isteği tek başına ekleyemez).
   * Boş liste = her şey reddedilir. Kökler MUTLAK yol olmak zorundadır:
   * göreli kök CWD'ye bağımlı olup determinizmi bozar (TŞ §6).
   */
  allowRoots: z
    .array(
      noNullByte("allowRoot entry")
        .refine(
          (value) => path.isAbsolute(value),
          "allowRoot must be an absolute path (a relative root would depend on the CWD)",
        )
        // Windows: `\work` is "absolute" for path.isAbsolute but depends on the
        // current drive, and UNC/device forms are network or device paths.
        .refine(
          (value) => !IS_WIN || isWindowsDriveAbsolutePath(value),
          "allowRoot must be a drive-letter absolute path on Windows (for example C:\\work\\repo)",
        )
        .refine(
          (value) => !IS_WIN || findWindowsUnsafePathSegment(value) === undefined,
          "allowRoot must not contain a colon after the drive, a segment ending with a dot or a space, or a reserved device name",
        ),
    )
    .default([]),
  /** Default ignore listesi; verilmemişse TŞ §20 listesi kullanılır. */
  ignore: z.array(noNullByte("ignore pattern")).default([...DEFAULT_IGNORE_PATTERNS]),
  /** Kullanıcı ignore'ları default'ların/ignore'un ÜZERİNE eklenir (birleşim). */
  extraIgnore: z.array(noNullByte("extraIgnore pattern")).default([]),
  /** Binary uzantı kara listesi (blacklist modunda kullanılır). */
  binaryExtensions: z.array(extensionSchema).default([...DEFAULT_BINARY_EXTENSIONS]),
  /** Uzantı filtresi modu: blacklist (default) veya whitelist. */
  extensionFilterMode: z.enum(["blacklist", "whitelist"]).default("blacklist"),
  /** Whitelist modunda izinli uzantılar; uzantısız dosya yalnızca "" ile izinli olur. */
  allowedExtensions: z.array(extensionSchema).default([]),
  /** Tek dosya üst sınırı (bayt); aşımı LIMIT_EXCEEDED (TŞ §19 kaynak tüketimi). */
  maxFileBytes: z
    .number()
    .int("maxFileBytes must be an integer")
    .positive("maxFileBytes must be positive")
    .max(Number.MAX_SAFE_INTEGER, "maxFileBytes must be within the safe integer range")
    .default(DEFAULT_MAX_FILE_BYTES),
});

/** Geçerli (default'ları uygulanmış) politika konfigürasyonu. */
export type WorkspacePolicyConfig = z.infer<typeof workspacePolicyConfigSchema>;

/** Etkin ignore listesi: ignore + extraIgnore birleşimi (sıra korunur). */
export function effectiveIgnorePatterns(config: WorkspacePolicyConfig): readonly string[] {
  return [...config.ignore, ...config.extraIgnore];
}

export type ParsedPolicyConfig =
  | { readonly ok: true; readonly config: WorkspacePolicyConfig }
  | {
      readonly ok: false;
      readonly code: Extract<PolicyErrorCode, "workspace/policy-invalid">;
      readonly issues: readonly string[];
    };

function deepFreezeConfig(config: WorkspacePolicyConfig): WorkspacePolicyConfig {
  const frozen = {
    allowRoots: Object.freeze([...config.allowRoots]),
    ignore: Object.freeze([...config.ignore]),
    extraIgnore: Object.freeze([...config.extraIgnore]),
    binaryExtensions: Object.freeze([...config.binaryExtensions]),
    extensionFilterMode: config.extensionFilterMode,
    allowedExtensions: Object.freeze([...config.allowedExtensions]),
    maxFileBytes: config.maxFileBytes,
  } as WorkspacePolicyConfig;
  return Object.freeze(frozen);
}

/**
 * Konfigürasyonu doğrular ve default'ları uygular; fırlatmaz — sonuç
 * ayrıştırıcı birleşimdir (deterministik karar, TŞ §10.1 POLICY_INVALID).
 */
export function parseWorkspacePolicyConfig(input: unknown): ParsedPolicyConfig {
  const result = workspacePolicyConfigSchema.safeParse(input);
  if (result.success) {
    return { ok: true, config: deepFreezeConfig(result.data) };
  }
  const issues = result.error.issues.map(
    (issue) => `${issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)"}: ${issue.message}`,
  );
  return { ok: false, code: "workspace/policy-invalid", issues };
}
