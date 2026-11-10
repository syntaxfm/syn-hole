import type { SyntaxSession, SyntaxAnswer, SyntaxPlayer } from "./types";
import type { SyntaxHistoryPage, SyntaxHistorySummary } from "./history";
import { SYNTAX_HISTORY_MAX_OFFSET } from "~/syntax-game/history";

export type RuntimeStorage = Pick<DurableObjectStorage, "sql" | "transactionSync" | "setAlarm" | "deleteAlarm">;
export type SyntaxRoomRecord = { mode: "poll" | "syntax"; generation: number; session: SyntaxSession | null };

/** Additive tables: never touch legacy poll data. Each write stores both the
 * active pointer and the complete immutable-snapshot history in one SQL txn. */
export class SyntaxRuntimeStore {
  private storage: RuntimeStorage;
  constructor(storage: RuntimeStorage) {
    this.storage = storage;
    storage.sql.exec("CREATE TABLE IF NOT EXISTS syntax_runtime (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS syntax_history (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS syntax_answers (game_id TEXT NOT NULL, round_index INTEGER NOT NULL, player_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(game_id, round_index, player_id))");
  }
  load(): SyntaxRoomRecord {
    const row = this.storage.sql.exec<{ data: string }>("SELECT data FROM syntax_runtime WHERE id=1").toArray()[0];
    return row ? JSON.parse(row.data) : { mode: "poll", generation: 0, session: null };
  }
  history(id: string): SyntaxSession | null {
    const row = this.storage.sql.exec<{ data: string }>("SELECT data FROM syntax_history WHERE id=?", id).toArray()[0];
    return row ? JSON.parse(row.data) : null;
  }
  listHistory({ limit, offset }: { limit: number; offset: number }): SyntaxHistoryPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > SYNTAX_HISTORY_MAX_OFFSET) throw new Error("Invalid history pagination.");
    // SQLite extracts only bounded summary fields, not full private answers or
    // images. rowid is stable across upserts, giving newest-launch-first pages.
    const rows = this.storage.sql.exec<SyntaxHistorySummary>(`SELECT id,
      substr(json_extract(data,'$.snapshot.title'),1,240) AS title,
      json_extract(data,'$.snapshot.preparedAt') AS preparedAt,
      json_extract(data,'$.phase') AS phase,
      json_extract(data,'$.snapshot.submissionMode') AS submissionMode,
      json_array_length(data,'$.snapshot.rounds') AS rounds,
      json_array_length(data,'$.revealedRoundIndexes') AS revealedRounds,
      json_array_length(data,'$.players') AS participants
      FROM syntax_history ORDER BY rowid DESC LIMIT ? OFFSET ?`, limit + 1, offset).toArray();
    return { games: rows.slice(0, limit), nextOffset: rows.length > limit && offset + limit <= SYNTAX_HISTORY_MAX_OFFSET ? offset + limit : null };
  }
  save(record: SyntaxRoomRecord, accepted?: { answer: SyntaxAnswer; player: SyntaxPlayer }) {
    this.storage.transactionSync(() => {
      // A plain INSERT (not replace/upsert) makes uniqueness durable across
      // sockets/restarts. Session/history and the indexed receipt commit together.
      if (accepted && record.session) this.storage.sql.exec("INSERT INTO syntax_answers(game_id,round_index,player_id,data) VALUES(?,?,?,?)", record.session.snapshot.id, accepted.answer.roundIndex, accepted.player.id, JSON.stringify(accepted));
      this.storage.sql.exec("INSERT INTO syntax_runtime(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", JSON.stringify(record));
      if (record.session) this.storage.sql.exec("INSERT INTO syntax_history(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", record.session.snapshot.id, JSON.stringify(record.session));
    });
  }
}
