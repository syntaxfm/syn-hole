import type { SyntaxAnswer, SyntaxGroupStandings, SyntaxPlayer, SyntaxStanding, SyntaxTiming, SyntaxRoundGroupStandings } from "~/syntax-game/types";

export const SYNTAX_MAX_POINTS = 1_000;

export function assertSyntaxTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Timestamp must be a non-negative safe integer in milliseconds.");
}

/** Server receipt time only. Open interval at the deadline: [openedAt, deadlineAt).
 * Nearest integer (Math.round); a very late hit may round to zero. No proximity bonus.
 */
export function scoreSyntaxAnswer(correct: boolean, receivedAt: number, timing: SyntaxTiming): number {
  assertSyntaxTimestamp(receivedAt);
  assertSyntaxTimestamp(timing.openedAt);
  assertSyntaxTimestamp(timing.deadlineAt);
  if (timing.deadlineAt <= timing.openedAt) throw new Error("Deadline must be after opening.");
  if (!correct || receivedAt < timing.openedAt || receivedAt >= timing.deadlineAt) return 0;
  return Math.round(SYNTAX_MAX_POINTS * (timing.deadlineAt - receivedAt) / (timing.deadlineAt - timing.openedAt));
}

/** Aggregate points are the only competitive tie-breaker (no hidden speed or
 * proximity tie-break). Ties share competition ranks: 1,1,3. Player id gives a
 * stable locale-independent display order. Include joined non-answerers at zero.
 * Pass only revealed rounds for public standings; all rounds for admin analysis.
 */
export function rankSyntaxPlayers(
  players: readonly SyntaxPlayer[],
  answers: readonly SyntaxAnswer[],
  roundIndexes: readonly number[]
): SyntaxStanding[] {
  const included = new Set(roundIndexes);
  const totals = new Map<string, { points: number; correct: number; answered: number }>();
  for (const answer of answers) {
    if (!included.has(answer.roundIndex)) continue;
    const total = totals.get(answer.playerId) ?? { points: 0, correct: 0, answered: 0 };
    total.points += answer.points;
    total.correct += Number(answer.correct);
    total.answered++;
    totals.set(answer.playerId, total);
  }
  const rows = players.map((player) => ({
    playerId: player.id, name: player.name, playMode: player.playMode,
    ...(totals.get(player.id) ?? { points: 0, correct: 0, answered: 0 }), rank: 0,
  })).sort((a, b) => b.points - a.points || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
  let rank = 0;
  return rows.map((row, index) => {
    if (index === 0 || row.points !== rows[index - 1].points) rank = index + 1;
    return { ...row, rank };
  });
}

/** Group winners, not team-summed scores. Null/unassigned players retain their
 * own bucket when grouping is enabled; never silently place them in a group.
 */
export function groupSyntaxStandings(
  players: readonly SyntaxPlayer[], answers: readonly SyntaxAnswer[], roundIndexes: readonly number[], askPlayMode: boolean
): SyntaxGroupStandings[] {
  if (!askPlayMode) return [{ playMode: null, total: players.length, standings: rankSyntaxPlayers(players, answers, roundIndexes).map((row) => ({ ...row, playMode: null })) }];
  const modes = ["in-person", "online", null] as const;
  return modes.filter((mode) => players.some((player) => player.playMode === mode)).map((mode) => ({
    playMode: mode,
    total: players.filter((player) => player.playMode === mode).length,
    standings: rankSyntaxPlayers(players.filter((player) => player.playMode === mode), answers, roundIndexes),
  }));
}

/** Correct answers only. Elapsed server time is the sole round ranking key;
 * equal times share competition ranks, with stable id order for presentation. */
export function groupSyntaxRoundStandings(players: readonly SyntaxPlayer[], answers: readonly SyntaxAnswer[], roundIndex: number, openedAt: number, askPlayMode: boolean): SyntaxRoundGroupStandings[] {
  const byPlayer = new Map(players.map((p) => [p.id, p]));
  const rows = answers.filter((a) => a.roundIndex === roundIndex && a.correct && byPlayer.has(a.playerId)).map((a) => {
    const player = byPlayer.get(a.playerId)!;
    return { playerId: player.id, name: player.name, playMode: askPlayMode ? player.playMode : null, elapsedMs: a.elapsedMs ?? a.receivedAt - openedAt, rank: 0 };
  });
  const modes = askPlayMode ? ["in-person", "online", null] as const : [null];
  return modes.filter((mode) => !askPlayMode || players.some((p) => p.playMode === mode)).map((playMode) => {
    const sorted = rows.filter((row) => row.playMode === playMode).sort((a, b) => a.elapsedMs - b.elapsedMs || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
    let rank = 0;
    const standings = sorted.map((row, index) => {
      if (index === 0 || row.elapsedMs !== sorted[index - 1].elapsedMs) rank = index + 1;
      return { ...row, rank };
    });
    return { playMode, standings, total: standings.length };
  });
}
