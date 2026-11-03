import {
  canonicalJson,
  sha256Hex,
  utf8Encode,
  type RevisionRef,
} from "@causoryn/domain";

/**
 * Build kimliği — building aşamasındaki indeksleme kaydının iç kimliği.
 *
 * Snapshot ID'sinin aksine build kimliği İÇERİK KARMASI İÇERMEZ (içerik
 * publish anında belli olur) ve depo örneğine özgü bir sıra numarası
 * taşır: aynı girdilerle başlatılan iki ayrı build iki ayrı kimlik alır.
 * Bu kimlik hiçbir zaman okuma sözleşmesinde görünmez; publish ile
 * tüketilir ve yerine deterministik snapshot ID geçer (TŞ v2.1 §8
 * invariant iii/vi, ADR-005).
 */
export interface BuildIdInput {
  readonly workspaceId: string;
  readonly revision: RevisionRef;
  readonly configHash: string;
  readonly analyzerFingerprint: string;
}

export function deriveBuildId(input: BuildIdInput, serial: number): string {
  return `build:${sha256Hex(
    utf8Encode(
      canonicalJson([
        input.workspaceId,
        input.revision.id,
        input.revision.sequence,
        input.configHash,
        input.analyzerFingerprint,
        serial,
      ]),
    ),
  )}`;
}
