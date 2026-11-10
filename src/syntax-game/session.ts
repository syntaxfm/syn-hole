import type {
  SyntaxLibraryEntry, SyntaxPlayer, SyntaxSession, SyntaxSessionSnapshot,
} from "~/syntax-game/types";
import { parseSyntaxId, parseSyntaxLibrary, parseSyntaxSavedSet, SYNTAX_MAX_PLAYER_NAME_LENGTH, SYNTAX_MAX_PLAYERS, SYNTAX_MAX_SNAPSHOT_BYTES } from "~/syntax-game/validation";
import { assertSyntaxTimestamp } from "~/syntax-game/scoring";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Launch captures independent, deeply frozen data. Missing entries fail here,
 * not halfway through a game. Later library/set edits never refresh this copy.
 * Image URLs must remain immutable and retained by the persistence layer.
 */
export function prepareSyntaxSession(
  id: string, rawSet: unknown, rawLibrary: unknown, preparedAt: number, askPlayMode: boolean
): SyntaxSession {
  parseSyntaxId(id, "Session");
  assertSyntaxTimestamp(preparedAt);
  if (typeof askPlayMode !== "boolean") throw new Error("askPlayMode must be boolean.");
  const set = parseSyntaxSavedSet(rawSet);
  const library = new Map<string, SyntaxLibraryEntry>(parseSyntaxLibrary(rawLibrary).map((entry) => [entry.id, entry]));
  const snapshot: SyntaxSessionSnapshot = {
    id, setId: set.id, title: set.title, preparedAt, askPlayMode, submissionMode: set.submissionMode,
    rounds: set.rounds.map((round) => {
      const entry = library.get(round.entryId);
      if (!entry) throw new Error(`Set "${set.id}" references missing library entry "${round.entryId}".`);
      return { entry, durationMs: round.durationMs ?? set.defaultDurationMs };
    }),
  };
  return freeze({ snapshot, phase: "prepared", roundIndex: 0, timing: null, players: [], answers: [], revealedRoundIndexes: [] });
}

/** Browser voter identity is supplied by the room; this is not authentication.
 * Reconnects keep existing membership/name/group; late joins may enter any phase.
 * No disconnect/removal helper: history and scores survive disconnections.
 */
export function joinSyntaxSession(session: SyntaxSession, player: SyntaxPlayer): SyntaxSession {
  parseSyntaxId(player.id, "Player");
  if (session.players.some((existing) => existing.id === player.id)) return session;
  if (session.players.length >= SYNTAX_MAX_PLAYERS) throw new Error(`Game capacity is ${SYNTAX_MAX_PLAYERS} players.`);
  if (typeof player.name !== "string" || !player.name.trim() || player.name.length > SYNTAX_MAX_PLAYER_NAME_LENGTH) {
    throw new Error(`Player name must be 1 to ${SYNTAX_MAX_PLAYER_NAME_LENGTH} characters.`);
  }
  if (player.playMode !== null && player.playMode !== "in-person" && player.playMode !== "online") throw new Error("Invalid player playMode.");
  return freeze({ ...session, players: [...session.players, {
    id: player.id, name: player.name, playMode: session.snapshot.askPlayMode ? player.playMode : null,
  }] });
}

/** Leave ample headroom below the platform's 2 MB SQL value/row limit. */
export function serializeSyntaxSnapshot(snapshot: SyntaxSessionSnapshot): string {
  const body = JSON.stringify(snapshot);
  if (new TextEncoder().encode(body).byteLength > SYNTAX_MAX_SNAPSHOT_BYTES) throw new Error("Game snapshot is too large. Use fewer rounds or shorter text.");
  return body;
}

export function startSyntaxRound(session: SyntaxSession, now: number): SyntaxSession {
  if (session.phase !== "prepared") throw new Error("Only a prepared round can start.");
  assertSyntaxTimestamp(now);
  if (now < session.snapshot.preparedAt) throw new Error("Round cannot start before session preparation.");
  const deadlineAt = now + session.snapshot.rounds[session.roundIndex].durationMs;
  assertSyntaxTimestamp(deadlineAt);
  return freeze({ ...session, phase: "open", timing: { openedAt: now, deadlineAt } });
}

/** Called by the runtime's timer and before processing a submission. Only close:
 * never automatically reveal, advance, finish, delete history, or change mode.
 */
export function closeExpiredSyntaxRound(session: SyntaxSession, now: number): SyntaxSession {
  assertSyntaxTimestamp(now);
  if (session.phase !== "open" || !session.timing || now < session.timing.deadlineAt) return session;
  return freeze({ ...session, phase: "closed" });
}

export function revealSyntaxRound(session: SyntaxSession): SyntaxSession {
  if (session.phase !== "closed") throw new Error("Only a closed round can be revealed.");
  return freeze({ ...session, phase: "revealed", revealedRoundIndexes: [...session.revealedRoundIndexes, session.roundIndex] });
}

/** Manual next prepares, rather than starts, the next round. Final reveal can
 * only finish. No restart/rewind: prepare a new session with a new id instead.
 */
export function advanceSyntaxSession(session: SyntaxSession): SyntaxSession {
  if (session.phase !== "revealed") throw new Error("Reveal the round before advancing.");
  if (session.roundIndex === session.snapshot.rounds.length - 1) return freeze({ ...session, phase: "finished" });
  return freeze({ ...session, phase: "prepared", roundIndex: session.roundIndex + 1, timing: null });
}

/** Runtime must require explicit confirmed abort before switching an active room
 * to polls. This preserves the snapshot, images, submissions and revealed history;
 * it does not reveal unfinished answers. Room mode/poll persistence is separate.
 */
export function abortSyntaxSession(session: SyntaxSession): SyntaxSession {
  if (session.phase === "finished" || session.phase === "aborted") throw new Error("Session is already terminal.");
  return freeze({ ...session, phase: "aborted" });
}
