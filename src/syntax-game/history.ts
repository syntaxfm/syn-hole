import type { SyntaxSession } from "./types";
import { groupSyntaxStandings } from "~/syntax-game/scoring";

export type SyntaxHistorySummary = {
  id: string;
  title: string;
  preparedAt: number;
  phase: SyntaxSession["phase"];
  submissionMode: SyntaxSession["snapshot"]["submissionMode"];
  rounds: number;
  revealedRounds: number;
  participants: number;
};
export type SyntaxHistoryPage = { games: SyntaxHistorySummary[]; nextOffset: number | null };
export const SYNTAX_HISTORY_PAGE_SIZE = 20;
export const SYNTAX_HISTORY_MAX_OFFSET = 100_000;

export function historyId(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return /^[a-zA-Z0-9_-]{1,128}$/.test(decoded) ? decoded : null;
  } catch { return null; }
}

export function historyPagination(params: URLSearchParams): { limit: number; offset: number } | null {
  const parse = (key: string, fallback: number, min: number, max: number) => {
    const values = params.getAll(key);
    if (!values.length) return fallback;
    if (values.length !== 1 || !/^\d{1,6}$/.test(values[0])) return null;
    const n = Number(values[0]);
    return n >= min && n <= max ? n : null;
  };
  const limit = parse("limit", SYNTAX_HISTORY_PAGE_SIZE, 1, 50);
  const offset = parse("offset", 0, 0, SYNTAX_HISTORY_MAX_OFFSET);
  return limit === null || offset === null ? null : { limit, offset };
}

/** Official totals never silently include an aborted/unrevealed round. Raw
 * persisted answers remain separately available to authenticated admins. */
export function syntaxHistoryStandings(session: SyntaxSession, throughRound?: number) {
  const rounds = session.revealedRoundIndexes.filter((index) => throughRound === undefined || index <= throughRound);
  return groupSyntaxStandings(session.players, session.answers, rounds, session.snapshot.askPlayMode);
}
