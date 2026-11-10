import type { SyntaxLibraryRecord } from "~/syntax-game/library";
import type { SyntaxSavedSet, SyntaxSubmissionMode } from "~/syntax-game/types";
import { parseSyntaxSavedSet } from "~/syntax-game/validation";
import { syntaxReviewIssue } from "~/utils/syntax-editor";

export const SYNTAX_SETS_ENDPOINT = "/api/admin/syntax/sets";
export function syntaxSetEndpoint(id: string): string { return `${SYNTAX_SETS_ENDPOINT}/${encodeURIComponent(id)}`; }
/** Strings preserve incomplete numeric input without silently replacing it with a default. */
export type SyntaxSetDraft = {
  id: string; title: string; defaultSeconds: string; submissionMode: SyntaxSubmissionMode;
  rounds: Array<{ entryId: string; seconds: string }>;
};
export function createSyntaxSetDraft(id: string): SyntaxSetDraft {
  return { id, title: "", defaultSeconds: "30", submissionMode: "first-click", rounds: [] };
}
export function syntaxSetToDraft(set: SyntaxSavedSet): SyntaxSetDraft {
  return { id: set.id, title: set.title, defaultSeconds: String(set.defaultDurationMs / 1000), submissionMode: set.submissionMode,
    rounds: set.rounds.map(round => ({ entryId: round.entryId, seconds: round.durationMs === undefined ? "" : String(round.durationMs / 1000) })) };
}
function milliseconds(seconds: string, label: string): number {
  const value = seconds.trim() ? Number(seconds) : NaN;
  const ms = Math.round(value * 1000);
  if (!Number.isFinite(value) || value < 1 || value > 300 || Math.abs(value * 1000 - ms) > 0.000001) throw new Error(`${label} must be 1–300 seconds (up to three decimal places).`);
  return ms;
}
export function parseSyntaxSetDraft(draft: SyntaxSetDraft): SyntaxSavedSet {
  if (!draft.rounds.length) throw new Error("Add at least one screenshot. Empty sets are not saved or launchable.");
  if (new Set(draft.rounds.map(round => round.entryId)).size !== draft.rounds.length) throw new Error("Each screenshot can appear only once in a saved set.");
  return parseSyntaxSavedSet({ id: draft.id, title: draft.title, submissionMode: draft.submissionMode,
    defaultDurationMs: milliseconds(draft.defaultSeconds, "Default time"),
    rounds: draft.rounds.map((round, index) => ({ entryId: round.entryId, ...(round.seconds.trim() ? { durationMs: milliseconds(round.seconds, `Round ${index + 1} time`) } : {}) })) });
}
export function syntaxSetDraftIssue(draft: SyntaxSetDraft): string | null {
  try { parseSyntaxSetDraft(draft); return null; } catch (error) { return error instanceof Error ? error.message : "Check set details."; }
}
export function syntaxSetMemberIssue(entry: SyntaxLibraryRecord | undefined): string | null {
  if (!entry) return "Screenshot is missing from the library. Remove it explicitly or restore it before launch.";
  if (entry.status !== "reviewed") return "Screenshot is draft / unreviewed. Review it in the library before launch.";
  return syntaxReviewIssue(entry);
}
export function syntaxSetLaunchIssues(draft: SyntaxSetDraft, entries: readonly SyntaxLibraryRecord[]): string[] {
  const issue = syntaxSetDraftIssue(draft);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  return [...(issue ? [issue] : []), ...draft.rounds.flatMap((round, index) => {
    const issue = syntaxSetMemberIssue(byId.get(round.entryId));
    return issue ? [`Round ${index + 1}: ${issue}`] : [];
  })];
}
