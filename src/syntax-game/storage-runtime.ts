import type { SyntaxSession, SyntaxSessionSnapshot, SyntaxAnswer, SyntaxPlayer } from "./types";
import type { SyntaxHistoryPage, SyntaxHistorySummary } from "./history";
import { SYNTAX_HISTORY_MAX_OFFSET } from "~/syntax-game/history";
import { serializeSyntaxSnapshot } from "~/syntax-game/session";

export type RuntimeStorage = Pick<DurableObjectStorage, "sql" | "transactionSync" | "setAlarm" | "deleteAlarm">;
export type SyntaxRoomRecord = { mode: "poll" | "syntax"; generation: number; session: SyntaxSession | null };
type StoredRoom = Omit<SyntaxRoomRecord, "session"> & { storageVersion: 2; sessionId: string | null };
type StoredSession = Omit<SyntaxSession, "snapshot" | "players" | "answers"> & {
  storageVersion: 2; snapshot: Omit<SyntaxSessionSnapshot, "rounds">; roundCount: number; participants: number;
};
type Change = { player: SyntaxPlayer; answer?: SyntaxAnswer };

/** Bounded metadata plus separate snapshot, membership and answer rows. Each
 * answer writes ONE receipt and small metadata, never the accumulated game.
 * Older full-session rows remain readable and migrate atomically on next save. */
export class SyntaxRuntimeStore {
  private storage: RuntimeStorage;
  constructor(storage: RuntimeStorage) {
    this.storage = storage;
    storage.sql.exec("CREATE TABLE IF NOT EXISTS syntax_runtime (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS syntax_history (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS syntax_answers (game_id TEXT NOT NULL, round_index INTEGER NOT NULL, player_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(game_id, round_index, player_id))");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS syntax_players (game_id TEXT NOT NULL, player_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(game_id, player_id))");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS syntax_runtime_snapshots (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  }
  load(): SyntaxRoomRecord {
    const row = this.storage.sql.exec<{ data: string }>("SELECT data FROM syntax_runtime WHERE id=1").toArray()[0];
    if (!row) return { mode: "poll", generation: 0, session: null };
    const stored = JSON.parse(row.data) as StoredRoom | SyntaxRoomRecord;
    if (!("storageVersion" in stored)) return stored;
    const session = stored.sessionId ? this.history(stored.sessionId) : null;
    if (stored.sessionId && !session) throw new Error("Missing retained syntax session.");
    return { mode: stored.mode, generation: stored.generation, session };
  }
  history(id: string): SyntaxSession | null {
    const row = this.storage.sql.exec<{ data: string }>("SELECT data FROM syntax_history WHERE id=?", id).toArray()[0];
    if (!row) return null;
    const stored = JSON.parse(row.data) as StoredSession | SyntaxSession;
    if (!("storageVersion" in stored)) return stored;
    const snapshot = this.storage.sql.exec<{ data: string }>("SELECT data FROM syntax_runtime_snapshots WHERE id=?", id).toArray()[0];
    if (!snapshot) throw new Error("Missing immutable syntax snapshot.");
    const players = this.storage.sql.exec<{ data: string }>("SELECT data FROM syntax_players WHERE game_id=? ORDER BY rowid", id).toArray().map(row => JSON.parse(row.data) as SyntaxPlayer);
    const answers = this.storage.sql.exec<{ data: string }>("SELECT data FROM syntax_answers WHERE game_id=? ORDER BY rowid", id).toArray().map(row => (JSON.parse(row.data) as Change).answer!);
    return { snapshot: JSON.parse(snapshot.data), phase: stored.phase, roundIndex: stored.roundIndex, timing: stored.timing, revealedRoundIndexes: stored.revealedRoundIndexes, players, answers };
  }
  listHistory({ limit, offset }: { limit: number; offset: number }): SyntaxHistoryPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > SYNTAX_HISTORY_MAX_OFFSET) throw new Error("Invalid history pagination.");
    // Both original and normalized rows expose only bounded summary fields.
    const rows = this.storage.sql.exec<SyntaxHistorySummary>(`SELECT id,
      substr(json_extract(data,'$.snapshot.title'),1,240) AS title,
      json_extract(data,'$.snapshot.preparedAt') AS preparedAt,
      json_extract(data,'$.phase') AS phase,
      json_extract(data,'$.snapshot.submissionMode') AS submissionMode,
      coalesce(json_extract(data,'$.roundCount'),json_array_length(data,'$.snapshot.rounds')) AS rounds,
      json_array_length(data,'$.revealedRoundIndexes') AS revealedRounds,
      coalesce(json_extract(data,'$.participants'),json_array_length(data,'$.players')) AS participants
      FROM syntax_history ORDER BY rowid DESC LIMIT ? OFFSET ?`, limit + 1, offset).toArray();
    return { games: rows.slice(0, limit), nextOffset: rows.length > limit && offset + limit <= SYNTAX_HISTORY_MAX_OFFSET ? offset + limit : null };
  }
  save(record: SyntaxRoomRecord, change?: Change) {
    this.storage.transactionSync(() => {
      const session = record.session;
      if (session) {
        const id = session.snapshot.id;
        const old = this.storage.sql.exec<{ data: string }>("SELECT data FROM syntax_history WHERE id=?", id).toArray()[0];
        const normalized = old && JSON.parse(old.data).storageVersion === 2;
        if (!normalized) {
          // Grandfather snapshots that already fit in a legacy SQL row. The
          // new launch budget must never prevent abort/recovery of an existing
          // game. Copy its retained immutable snapshot, not a caller's changes.
          const snapshotBody = old ? JSON.stringify((JSON.parse(old.data) as SyntaxSession).snapshot) : serializeSyntaxSnapshot(session.snapshot);
          this.storage.sql.exec("INSERT INTO syntax_runtime_snapshots(id,data) VALUES(?,?)", id, snapshotBody);
          for (const player of session.players) this.storage.sql.exec("INSERT INTO syntax_players(game_id,player_id,data) VALUES(?,?,?)", id, player.id, JSON.stringify(player));
          const players = new Map(session.players.map(player => [player.id, player]));
          // Legacy games already have some indexed receipts. Retain them while
          // backfilling any older unindexed history, in original arrival order.
          for (const answer of session.answers) {
            if (change?.answer && answer.playerId === change.player.id && answer.roundIndex === change.answer.roundIndex) continue;
            this.storage.sql.exec("INSERT INTO syntax_answers(game_id,round_index,player_id,data) VALUES(?,?,?,?) ON CONFLICT DO NOTHING", id, answer.roundIndex, answer.playerId, JSON.stringify({ answer, player: players.get(answer.playerId) }));
          }
        } else if (change && !change.answer) {
          this.storage.sql.exec("INSERT INTO syntax_players(game_id,player_id,data) VALUES(?,?,?)", id, change.player.id, JSON.stringify(change.player));
        }
        // A plain INSERT enforces receipt uniqueness across sockets/restarts.
        if (change?.answer) this.storage.sql.exec("INSERT INTO syntax_answers(game_id,round_index,player_id,data) VALUES(?,?,?,?)", id, change.answer.roundIndex, change.player.id, JSON.stringify(change));
        const { rounds, ...snapshot } = session.snapshot;
        const stored: StoredSession = { storageVersion: 2, snapshot, roundCount: rounds.length, participants: session.players.length, phase: session.phase, roundIndex: session.roundIndex, timing: session.timing, revealedRoundIndexes: session.revealedRoundIndexes };
        this.storage.sql.exec("INSERT INTO syntax_history(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", id, JSON.stringify(stored));
      }
      const stored: StoredRoom = { storageVersion: 2, mode: record.mode, generation: record.generation, sessionId: session?.snapshot.id ?? null };
      this.storage.sql.exec("INSERT INTO syntax_runtime(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", JSON.stringify(stored));
    });
  }
}
