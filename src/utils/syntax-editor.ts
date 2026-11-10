import type { SyntaxLibraryRecord } from "~/syntax-game/library";
import { parseSyntaxLibraryEntry } from "~/syntax-game/validation";

export const SYNTAX_ENTRIES_ENDPOINT = "/api/admin/syntax/entries";
export function syntaxEntryEndpoint(id: string): string {
  return `${SYNTAX_ENTRIES_ENDPOINT}/${encodeURIComponent(id)}`;
}
export function createSyntaxDraft(id: string): SyntaxLibraryRecord {
  return { id, title: "", language: "", image: null, imageRevisionId: null, targets: [], explanation: "", status: "draft", provenance: { source: "", author: "", license: "" } };
}
export function syntaxReviewIssue(entry: SyntaxLibraryRecord): string | null {
  if (!entry.image || !entry.imageRevisionId) return "Upload a screenshot before review or launch.";
  if (!entry.language.trim()) return "Add a language before review or launch.";
  try { parseSyntaxLibraryEntry(entry); return null; }
  catch (error) { return error instanceof Error ? error.message : "Check the title and targets."; }
}
/** Missing images and targets are allowed in drafts; malformed targets are not. */
export function syntaxDraftIssue(entry: SyntaxLibraryRecord): string | null {
  if ([entry.title, entry.language, entry.explanation ?? "", ...Object.values(entry.provenance)].some(value => value.length > 2000)) return "Text fields must be at most 2000 characters.";
  try {
    parseSyntaxLibraryEntry({ ...entry, title: entry.title || "Draft", image: entry.image ?? { url: "/draft", width: 1, height: 1, alt: "Draft" }, targets: entry.targets.length ? entry.targets : [{ x: 0, y: 0, radius: 0.05 }] });
    return entry.status === "reviewed" ? syntaxReviewIssue(entry) : null;
  } catch (error) { return error instanceof Error ? error.message : "Check the targets."; }
}
export function syntaxUploadIssue(file: Pick<File, "size" | "type">): string | null {
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) return "Choose a still PNG, JPEG, GIF or WebP (no AVIF or animation).";
  if (!file.size || file.size > 10 * 1024 * 1024) return "Choose an image no larger than 10 MiB.";
  return null;
}
