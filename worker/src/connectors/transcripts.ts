/**
 * Origin-agnostic transcript normalization (ingestion-pipeline spec): Zoom,
 * Teams, and Meet transcripts all reduce to one schema. Speaker attribution
 * is carried through where the format provides it and flagged uncertain where
 * it does not. Recordings without transcripts are stored raw, not processed
 * (transcription is deferred).
 */

export interface TranscriptSegment {
  speaker: string | null;
  /** Offset or wall-clock as the source gives it; not normalized across formats. */
  startTs: string | null;
  text: string;
  /** False when the speaker was inferred or absent (spec: uncertainty flags). */
  attributionConfirmed: boolean;
}

export interface NormalizedTranscript {
  schema: "transcript.v1";
  origin: "vtt" | "zoom-txt" | "meet-doc" | "plain";
  segments: TranscriptSegment[];
}

/** WebVTT (Teams/Zoom exports): cues with optional `<v Speaker>` voice tags. */
function parseVtt(content: string): NormalizedTranscript {
  const segments: TranscriptSegment[] = [];
  const blocks = content.replace(/^WEBVTT.*?\n\n/s, "").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const timing = lines.findIndex((l) => l.includes("-->"));
    if (timing === -1) continue;
    const startTs = lines[timing]!.split("-->")[0]!.trim();
    const textLines = lines.slice(timing + 1).join(" ");
    const voice = textLines.match(/^<v\s+([^>]+)>\s*(.*)$/s);
    if (voice) {
      segments.push({
        speaker: voice[1]!.trim(),
        startTs,
        text: voice[2]!.replace(/<\/v>\s*$/, "").trim(),
        attributionConfirmed: true,
      });
    } else {
      // "Speaker: text" inside the cue, or bare text (attribution unknown).
      const labeled = textLines.match(/^([A-Z][\w .'-]{1,40}):\s+(.*)$/s);
      segments.push({
        speaker: labeled?.[1]?.trim() ?? null,
        startTs,
        text: (labeled?.[2] ?? textLines).trim(),
        attributionConfirmed: Boolean(labeled),
      });
    }
  }
  return { schema: "transcript.v1", origin: "vtt", segments };
}

/** Zoom .txt export: "HH:MM:SS Speaker Name: text" lines. */
function parseZoomTxt(content: string): NormalizedTranscript {
  const segments: TranscriptSegment[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^(\d{2}:\d{2}:\d{2})\s+([^:]{1,60}):\s+(.*)$/);
    if (m) {
      segments.push({
        speaker: m[2]!.trim(),
        startTs: m[1]!,
        text: m[3]!.trim(),
        attributionConfirmed: true,
      });
    }
  }
  return { schema: "transcript.v1", origin: "zoom-txt", segments };
}

/** Meet transcript Doc export: "Speaker Name: text" paragraphs, no timestamps. */
function parseMeetDoc(content: string): NormalizedTranscript {
  const segments: TranscriptSegment[] = [];
  for (const para of content.split(/\n+/)) {
    const m = para.match(/^([A-Z][\w .'-]{1,60}):\s+(.*)$/s);
    if (m) {
      segments.push({
        speaker: m[1]!.trim(),
        startTs: null,
        text: m[2]!.trim(),
        attributionConfirmed: true,
      });
    } else if (para.trim()) {
      segments.push({
        speaker: null,
        startTs: null,
        text: para.trim(),
        attributionConfirmed: false,
      });
    }
  }
  return { schema: "transcript.v1", origin: "meet-doc", segments };
}

/**
 * Detect format and normalize. Returns null when the content doesn't look
 * like a transcript at all (goes through the generic document path instead).
 */
export function normalizeTranscript(
  content: string,
  fileName: string,
): NormalizedTranscript | null {
  if (/^WEBVTT/m.test(content) || fileName.endsWith(".vtt")) return parseVtt(content);
  if (/^\d{2}:\d{2}:\d{2}\s+[^:]+:\s+/m.test(content)) return parseZoomTxt(content);

  // Speaker-labeled paragraphs → Meet-style transcript; otherwise not a transcript.
  const paras = content.split(/\n+/).filter((p) => p.trim());
  const labeled = paras.filter((p) => /^[A-Z][\w .'-]{1,60}:\s+/.test(p));
  if (paras.length >= 3 && labeled.length / paras.length >= 0.5) return parseMeetDoc(content);

  return null;
}
