import type {
  SyntaxImage, SyntaxLibraryEntry, SyntaxPoint, SyntaxSavedSet, SyntaxSubmissionMode,
} from "~/syntax-game/types";

export const SYNTAX_DEFAULT_DURATION_MS = 30_000;
export const SYNTAX_DEFAULT_SUBMISSION_MODE: SyntaxSubmissionMode = "first-click";
export const SYNTAX_MIN_DURATION_MS = 1_000;
export const SYNTAX_MAX_DURATION_MS = 300_000;
export const SYNTAX_MAX_ROUNDS = 100;
export const SYNTAX_MAX_PLAYERS = 1000;
export const SYNTAX_MAX_SNAPSHOT_BYTES = 1_048_576;
export const SYNTAX_MAX_TARGETS = 50;
export const SYNTAX_MAX_TEXT_LENGTH = 2_000;
export const SYNTAX_MAX_ID_LENGTH = 100;
export const SYNTAX_MAX_PLAYER_NAME_LENGTH = 100;
export const SYNTAX_MAX_IMAGE_DIMENSION = 32_768;
export const SYNTAX_MAX_RADIUS = 1;

export function parseSyntaxObject(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be an object.`);
  }
  return raw as Record<string, unknown>;
}

function text(raw: unknown, label: string, allowEmpty = false): string {
  if (typeof raw !== "string" || (!allowEmpty && !raw.trim()) || raw.length > SYNTAX_MAX_TEXT_LENGTH) {
    throw new Error(`${label} must be ${allowEmpty ? "" : "non-empty "}text of at most ${SYNTAX_MAX_TEXT_LENGTH} characters.`);
  }
  return raw;
}

export function parseSyntaxId(raw: unknown, label = "Id"): string {
  if (typeof raw !== "string" || raw.length > SYNTAX_MAX_ID_LENGTH || !/^[a-zA-Z0-9_-]+$/.test(raw)) {
    throw new Error(`${label} needs an id of letters, numbers, "-" or "_" (at most ${SYNTAX_MAX_ID_LENGTH}).`);
  }
  return raw;
}

function finite(raw: unknown, label: string, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max) {
    throw new Error(`${label} must be a finite number between ${min} and ${max}.`);
  }
  return raw;
}

export function parseSyntaxDuration(raw: unknown, label = "Duration"): number {
  const value = finite(raw, label, SYNTAX_MIN_DURATION_MS, SYNTAX_MAX_DURATION_MS);
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer number of milliseconds.`);
  return value;
}

/** Reject, never clamp. Unknown fields (including client score/timestamp) are not copied. */
export function parseSyntaxPoint(raw: unknown, label = "Point"): SyntaxPoint {
  const point = parseSyntaxObject(raw, label);
  return { x: finite(point.x, `${label}.x`, 0, 1), y: finite(point.y, `${label}.y`, 0, 1) };
}

function parseImage(raw: unknown, label: string): SyntaxImage {
  const image = parseSyntaxObject(raw, label);
  const url = text(image.url, `${label}.url`);
  // Root-relative assets or HTTP(S) only: no script/data URLs in public projections.
  if (!(url.startsWith("/") && !url.startsWith("//") && !/[\\\s]/.test(url))) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error(`${label}.url must be a root-relative or HTTP(S) URL.`); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error(`${label}.url must be a root-relative or HTTP(S) URL without credentials.`);
    }
  }
  const width = finite(image.width, `${label}.width`, 1, SYNTAX_MAX_IMAGE_DIMENSION);
  const height = finite(image.height, `${label}.height`, 1, SYNTAX_MAX_IMAGE_DIMENSION);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error(`${label} dimensions must be integers.`);
  return { url, width, height, alt: text(image.alt, `${label}.alt`) };
}

export function parseSyntaxLibraryEntry(raw: unknown): SyntaxLibraryEntry {
  const entry = parseSyntaxObject(raw, "Library entry");
  const id = parseSyntaxId(entry.id, "Library entry");
  if (!Array.isArray(entry.targets) || entry.targets.length < 1 || entry.targets.length > SYNTAX_MAX_TARGETS) {
    throw new Error(`Entry "${id}" needs 1 to ${SYNTAX_MAX_TARGETS} targets.`);
  }
  return {
    id,
    title: text(entry.title, `Entry "${id}" title`),
    image: parseImage(entry.image, `Entry "${id}" image`),
    targets: entry.targets.map((rawTarget, index) => {
      const label = `Entry "${id}" target ${index}`;
      const target = parseSyntaxObject(rawTarget, label);
      const radius = finite(target.radius, `${label}.radius`, 0, SYNTAX_MAX_RADIUS);
      if (radius === 0) throw new Error(`${label}.radius must be greater than zero.`);
      return { ...parseSyntaxPoint(target, label), radius };
    }),
    explanation: text(entry.explanation === undefined ? "" : entry.explanation, `Entry "${id}" explanation`, true),
  };
}

export function parseSyntaxLibrary(raw: unknown): SyntaxLibraryEntry[] {
  if (!Array.isArray(raw)) throw new Error("Library must be an array.");
  const ids = new Set<string>();
  return raw.map((value) => {
    const entry = parseSyntaxLibraryEntry(value);
    if (ids.has(entry.id)) throw new Error(`Duplicate library entry id "${entry.id}".`);
    ids.add(entry.id);
    return entry;
  });
}

export function parseSyntaxSavedSet(raw: unknown): SyntaxSavedSet {
  const set = parseSyntaxObject(raw, "Saved set");
  const id = parseSyntaxId(set.id, "Saved set");
  const mode = set.submissionMode === undefined ? SYNTAX_DEFAULT_SUBMISSION_MODE : set.submissionMode;
  if (mode !== "first-click" && mode !== "confirm") throw new Error(`Set "${id}" submissionMode must be "first-click" or "confirm".`);
  if (!Array.isArray(set.rounds) || set.rounds.length < 1 || set.rounds.length > SYNTAX_MAX_ROUNDS) {
    throw new Error(`Set "${id}" needs 1 to ${SYNTAX_MAX_ROUNDS} rounds.`);
  }
  return {
    id,
    title: text(set.title, `Set "${id}" title`),
    defaultDurationMs: set.defaultDurationMs === undefined ? SYNTAX_DEFAULT_DURATION_MS : parseSyntaxDuration(set.defaultDurationMs),
    submissionMode: mode,
    rounds: set.rounds.map((rawRound, index) => {
      const round = parseSyntaxObject(rawRound, `Set "${id}" round ${index}`);
      return {
        entryId: parseSyntaxId(round.entryId, `Set "${id}" round ${index}`),
        ...(round.durationMs === undefined ? {} : { durationMs: parseSyntaxDuration(round.durationMs) }),
      };
    }),
  };
}
