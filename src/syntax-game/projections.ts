import type {
  SyntaxRoundPublic, SyntaxRoundRevealed, SyntaxSession, SyntaxSessionPublic, SyntaxStanding,
  SyntaxRoundStanding, SyntaxPoint, SyntaxClickPage, SyntaxAnswer,
} from "~/syntax-game/types";
import { groupSyntaxStandings, groupSyntaxRoundStandings } from "~/syntax-game/scoring";
import { SyntaxProtocolError, syntaxRoundId } from "~/syntax-game/protocol";
import type { SyntaxAnswerReceipt } from "~/syntax-game/protocol";

export const SYNTAX_STANDINGS_LIMIT = 20;
export const SYNTAX_CLICK_PAGE_SIZE = 256;

function projectRound(session: SyntaxSession, roundIndex: number): SyntaxRoundPublic {
  const { entry, durationMs } = session.snapshot.rounds[roundIndex];
  return {
    roundIndex, title: entry.title, durationMs,
    image: { url: entry.image.url, width: entry.image.width, height: entry.image.height, alt: entry.image.alt },
  };
}

function projectReveal(session: SyntaxSession, roundIndex: number): SyntaxRoundRevealed {
  const { entry } = session.snapshot.rounds[roundIndex];
  return {
    ...projectRound(session, roundIndex),
    targets: entry.targets.map((target) => ({ x: target.x, y: target.y, radius: target.radius })),
    explanation: entry.explanation,
    yourResult: null,
  };
}

/** Audience/projector/reconnect/history share the same allowlist. Never spread a
 * stored entry/session/answer: even extra fields on persisted records stay private.
 * Revealed history only; current hidden-round scores/correct counts stay server-side.
 * Human-authored titles/alt text and asset filenames must not encode the solution.
 * Privileged admin/editor code uses SyntaxLibraryEntry, never this public contract.
 */
export function buildSyntaxSharedProjection(session: SyntaxSession) {
  const playerIds = new Set(session.players.map((p) => p.id));
  const currentAnswers = new Map(session.answers.filter((a) => a.roundIndex === session.roundIndex).map((a) => [a.playerId, a]));
  const revealed = session.revealedRoundIndexes.includes(session.roundIndex);
  // No rankings at all before the first reveal. Thereafter cumulative lists use
  // ONLY previously revealed rounds, so hidden-round hits cannot move any row.
  const groups = session.revealedRoundIndexes.length ? groupSyntaxStandings(session.players, session.answers, session.revealedRoundIndexes, session.snapshot.askPlayMode) : [];
  const yourStandings = new Map<string, SyntaxStanding>();
  for (const group of groups) for (const row of group.standings) yourStandings.set(row.playerId, row);
  const roundGroups = revealed && session.timing ? groupSyntaxRoundStandings(session.players, session.answers, session.roundIndex, session.timing.openedAt, session.snapshot.askPlayMode) : [];
  const yourRoundStandings = new Map<string, SyntaxRoundStanding>();
  for (const group of roundGroups) for (const row of group.standings) yourRoundStandings.set(row.playerId, row);
  // Sort by coordinates, NOT submission/identity/rank order. Pagination can't be
  // cross-referenced with a named fastest list or arrival sequence. Every point
  // is included (including duplicates and misses); no per-dot result metadata.
  const clicks = revealed ? [...currentAnswers.values()].map((a) => ({ x: a.point.x, y: a.point.y })).sort((a, b) => a.x - b.x || a.y - b.y) : null;
  const latestReveal = session.revealedRoundIndexes.at(-1);
  // Keep at most ONE full reveal in broadcast history, independent of game size.
  // Complete snapshots/answers/history remain durable server-side.
  const history = latestReveal === undefined ? [] : [projectReveal(session, latestReveal)];
  const base: SyntaxSessionPublic = {
    id: session.snapshot.id, title: session.snapshot.title, phase: session.phase,
    submissionMode: session.snapshot.submissionMode, totalRounds: session.snapshot.rounds.length,
    askPlayMode: session.snapshot.askPlayMode,
    currentRound: projectRound(session, session.roundIndex),
    timing: session.timing ? { openedAt: session.timing.openedAt, deadlineAt: session.timing.deadlineAt } : null,
    participants: session.players.length,
    totalResponses: currentAnswers.size,
    yourSubmission: null,
    reveal: history.find((round) => round.roundIndex === session.roundIndex) ?? null,
    history,
    standings: groups.map((group) => ({ playMode: group.playMode, standings: group.standings.slice(0, SYNTAX_STANDINGS_LIMIT), total: group.standings.length })),
    yourStanding: null,
    roundStandings: roundGroups.map((group) => ({ ...group, standings: group.standings.slice(0, SYNTAX_STANDINGS_LIMIT) })),
    yourRoundStanding: null,
    clicks: clicks ? clickPage(session.roundIndex, clicks, 0) : null,
    revealedRounds: session.revealedRoundIndexes.length,
  };
  const historyAnswers = new Map<string, SyntaxAnswer>();
  if (latestReveal !== undefined) for (const answer of session.answers) if (answer.roundIndex === latestReveal) historyAnswers.set(answer.playerId, answer);
  return { base, currentAnswers, historyAnswers, playerIds, yourStandings, yourRoundStandings, clicks };
}

export type SyntaxSharedProjection = ReturnType<typeof buildSyntaxSharedProjection>;

function clickPage(roundIndex: number, points: readonly SyntaxPoint[], offset: number): SyntaxClickPage {
  const end = Math.min(points.length, offset + SYNTAX_CLICK_PAGE_SIZE);
  return { roundIndex, points: points.slice(offset, end), total: points.length, nextOffset: end < points.length ? end : null };
}

export function projectSyntaxClickPage(session: SyntaxSession, shared: SyntaxSharedProjection, offset: number): SyntaxClickPage {
  if (!shared.clicks) throw new SyntaxProtocolError("not-revealed", "Clicks are private until the current round is revealed.");
  return clickPage(session.roundIndex, shared.clicks, offset);
}

export function syntaxAnswerReceipt(session: SyntaxSession, answer: SyntaxAnswer): SyntaxAnswerReceipt {
  return {
    gameId: session.snapshot.id, roundId: syntaxRoundId(session.snapshot.id, answer.roundIndex),
    point: { x: answer.point.x, y: answer.point.y }, receivedAt: answer.receivedAt,
    elapsedMs: answer.elapsedMs ?? answer.receivedAt - session.timing!.openedAt,
  };
}

/** Runtime builds shared data once per immutable session change, not per socket.
 * Personalization is O(1), including ranks beyond the bounded visible top rows. */
export function projectSyntaxSession(session: SyntaxSession, playerId?: string, shared = buildSyntaxSharedProjection(session)): SyntaxSessionPublic {
  const own = playerId ? shared.currentAnswers.get(playerId) : undefined;
  const joined = playerId !== undefined && shared.playerIds.has(playerId);
  const history = shared.base.history.map((round) => {
    const answer = playerId ? shared.historyAnswers.get(playerId) : undefined;
    return { ...round, yourResult: joined ? { correct: answer?.correct ?? false, points: answer?.points ?? 0 } : null };
  });
  return {
    ...shared.base,
    yourSubmission: own ? { x: own.point.x, y: own.point.y } : null,
    history,
    reveal: history.find((r) => r.roundIndex === session.roundIndex) ?? null,
    yourStanding: playerId ? shared.yourStandings.get(playerId) ?? null : null,
    yourRoundStanding: playerId ? shared.yourRoundStandings.get(playerId) ?? null : null,
  };
}
