import type { SyntaxImage, SyntaxLibraryEntry, SyntaxSavedSet, SyntaxSessionSnapshot } from "~/syntax-game/types";
import { parseSyntaxId, parseSyntaxLibraryEntry, parseSyntaxObject, parseSyntaxSavedSet } from "~/syntax-game/validation";
import { prepareSyntaxSession, serializeSyntaxSnapshot } from "~/syntax-game/session";

/** Server-only authoring wrapper. Drafts need not be valid playable entries. */
export type SyntaxLibraryRecord = Omit<SyntaxLibraryEntry, "image"> & {
  image: SyntaxImage | null;
  imageRevisionId: string | null;
  language: string;
  status: "draft" | "reviewed";
  provenance: { source: string; author: string; license: string };
};
export type SyntaxImageRevision = {
  id: string; entryId: string; key: string; image: SyntaxImage;
};
type Sql = { exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] } };
type Storage = { sql: Sql; transactionSync<T>(callback: () => T): T };

export class SyntaxLibraryError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
function text(value: unknown, label: string, empty = true): string {
  if (typeof value !== "string" || value.length > 2000 || (!empty && !value.trim())) {
    throw new SyntaxLibraryError(`${label} must be ${empty ? "" : "non-empty "}text of at most 2000 characters.`);
  }
  return value;
}

/** Additive tables only. Revision rows and snapshots are append-only and retained
 * even when authoring records are removed. No mutable poll-image URLs are used. */
export function ensureSyntaxLibrarySchema(sql: Sql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS syntax_entries (id TEXT PRIMARY KEY, body TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS syntax_sets (id TEXT PRIMARY KEY, body TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS syntax_set_members (set_id TEXT NOT NULL, entry_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(set_id, entry_id), UNIQUE(set_id, position))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS syntax_image_revisions (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, body TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS syntax_snapshots (id TEXT PRIMARY KEY, set_id TEXT NOT NULL, body TEXT NOT NULL)`);
}

export class SyntaxLibraryStore {
  private storage: Storage;
  constructor(storage: Storage) { this.storage = storage; }
  private read<T>(table: string, id: string): T {
    const row = this.storage.sql.exec(`SELECT body FROM ${table} WHERE id = ?`, id).toArray()[0];
    if (!row) throw new SyntaxLibraryError("Not found.", 404);
    return JSON.parse(row.body as string) as T;
  }
  private exists(table: string, id: string): boolean {
    return this.storage.sql.exec(`SELECT id FROM ${table} WHERE id = ?`, id).toArray().length > 0;
  }
  private write(table: string, id: string, body: unknown, create: boolean): void {
    const exists = this.exists(table, id);
    if (create && exists) throw new SyntaxLibraryError("Id already exists.", 409);
    if (!create && !exists) throw new SyntaxLibraryError("Not found.", 404);
    this.storage.sql.exec(`INSERT INTO ${table} (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body`, id, JSON.stringify(body));
  }
  listEntries(): SyntaxLibraryRecord[] { return this.list("syntax_entries"); }
  listSets(): SyntaxSavedSet[] { return this.list("syntax_sets"); }
  private list<T>(table: string): T[] {
    return this.storage.sql.exec(`SELECT body FROM ${table} ORDER BY id`).toArray().map(row => JSON.parse(row.body as string));
  }
  getEntry(id: string): SyntaxLibraryRecord { return this.read("syntax_entries", parseSyntaxId(id)); }
  getSet(id: string): SyntaxSavedSet { return this.read("syntax_sets", parseSyntaxId(id)); }

  /** Called ONLY by the trusted image upload implementation after storing bytes.
   * The uploader must never overwrite or delete a registered revision's bytes.
   * No HTTP authoring endpoint permits clients to assert image immutability. */
  registerImageRevision(raw: unknown): SyntaxImageRevision {
    const value = parseSyntaxObject(raw, "Image revision");
    const id = parseSyntaxId(value.id);
    const entryId = parseSyntaxId(value.entryId);
    const image = parseSyntaxObject(value.image, "Image");
    const url = `/api/syntax/images/${entryId}/${id}`;
    const key = `syntax/${entryId}/${id}`;
    if (value.key !== key || image.url !== url) throw new SyntaxLibraryError("Image revision must use its immutable syntax namespace.");
    const parsed = parseSyntaxLibraryEntry({ id: entryId, title: "Image", image, targets: [{ x: 0, y: 0, radius: 0.1 }] }).image;
    const revision = { id, entryId, key, image: parsed };
    if (this.exists("syntax_image_revisions", id)) {
      const existing = this.read<SyntaxImageRevision>("syntax_image_revisions", id);
      if (JSON.stringify(existing) !== JSON.stringify(revision)) throw new SyntaxLibraryError("Image revision is immutable.", 409);
      return existing;
    }
    this.storage.sql.exec("INSERT INTO syntax_image_revisions (id, entry_id, body) VALUES (?, ?, ?)", id, entryId, JSON.stringify(revision));
    return revision;
  }
  /** Trusted upload operation: bytes already exist in R2. Registration and the
   * authoring change either commit together or not at all. Published revisions
   * remain retained independently of the current authoring attachment. */
  attachImageRevision(entryId: string, raw: unknown): SyntaxLibraryRecord {
    return this.storage.transactionSync(() => {
      const entry = this.getEntry(entryId);
      const value = parseSyntaxObject(raw, "Image revision");
      if (value.entryId !== entry.id) throw new SyntaxLibraryError("Image revision belongs to another entry.");
      const revision = this.registerImageRevision(value);
      // An internal retry must not erase authoring work done after attachment.
      if (entry.imageRevisionId === revision.id) return entry;
      const updated: SyntaxLibraryRecord = { ...entry, imageRevisionId: revision.id, image: revision.image, status: "draft", targets: [], explanation: "" };
      this.write("syntax_entries", entry.id, updated, false);
      return updated;
    });
  }
  removeCurrentImage(entryId: string): SyntaxLibraryRecord {
    return this.storage.transactionSync(() => {
      const entry = this.getEntry(entryId);
      const updated: SyntaxLibraryRecord = { ...entry, imageRevisionId: null, image: null, status: "draft", targets: [], explanation: "" };
      this.write("syntax_entries", entry.id, updated, false);
      return updated;
    });
  }
  saveEntry(raw: unknown, create: boolean): SyntaxLibraryRecord {
    const value = parseSyntaxObject(raw, "Library record");
    const id = parseSyntaxId(value.id);
    if (value.status !== "draft" && value.status !== "reviewed") throw new SyntaxLibraryError("status must be draft or reviewed.");
    const existing = !create && this.exists("syntax_entries", id) ? this.getEntry(id) : null;
    const imageRevisionId = value.imageRevisionId === undefined ? existing?.imageRevisionId ?? null : value.imageRevisionId === null ? null : parseSyntaxId(value.imageRevisionId);
    let image: SyntaxImage | null = null;
    if (imageRevisionId) {
      const revision = this.read<SyntaxImageRevision>("syntax_image_revisions", imageRevisionId);
      if (revision.entryId !== id) throw new SyntaxLibraryError("Image revision belongs to another entry.");
      image = revision.image;
    }
    // A stale editor cannot reattach an old image and silently re-review targets
    // for different bytes. All attachment changes go through the image endpoint.
    if (existing && existing.imageRevisionId !== imageRevisionId) {
      throw new SyntaxLibraryError("Image changed. Reload the entry; use the image upload/removal endpoint to change its revision.", 409);
    }
    if (existing && value.status === "reviewed" && value.imageRevisionId !== existing.imageRevisionId) {
      throw new SyntaxLibraryError("Review must explicitly identify the current imageRevisionId. Reload the entry before reviewing.", 409);
    }
    const provenance = parseSyntaxObject(value.provenance ?? {}, "Provenance");
    const title = text(value.title ?? "", "Title");
    const targets = value.targets ?? [];
    if (!Array.isArray(targets)) throw new SyntaxLibraryError("targets must be an array.");
    // Reuse the foundation parser even for partial drafts, with harmless placeholders.
    const parsed = parseSyntaxLibraryEntry({ id, title: title || "Draft", image: image ?? { url: "/draft", width: 1, height: 1, alt: "Draft" }, targets: targets.length ? targets : [{ x: 0, y: 0, radius: 0.1 }], explanation: value.explanation ?? "" });
    const record: SyntaxLibraryRecord = {
      ...parsed, title, targets: targets.length ? parsed.targets : [], image, imageRevisionId,
      language: text(value.language ?? "", "Language"), status: value.status,
      provenance: { source: text(provenance.source ?? "", "Source"), author: text(provenance.author ?? "", "Author"), license: text(provenance.license ?? "", "License") },
    };
    if (record.status === "reviewed") this.playable(record);
    this.write("syntax_entries", id, record, create);
    return record;
  }
  private playable(record: SyntaxLibraryRecord): SyntaxLibraryEntry {
    if (record.status !== "reviewed" || !record.language.trim() || !record.imageRevisionId || !record.image) {
      throw new SyntaxLibraryError(`Entry ${record.id} must be reviewed with language and an immutable image.`, 409);
    }
    const revision = this.read<SyntaxImageRevision>("syntax_image_revisions", record.imageRevisionId);
    if (revision.entryId !== record.id || JSON.stringify(revision.image) !== JSON.stringify(record.image)) throw new SyntaxLibraryError("Image revision mismatch.", 409);
    return parseSyntaxLibraryEntry(record);
  }
  saveSet(raw: unknown, create: boolean): SyntaxSavedSet {
    const set = parseSyntaxSavedSet(raw);
    if (new Set(set.rounds.map(round => round.entryId)).size !== set.rounds.length) throw new SyntaxLibraryError("Duplicate set membership.");
    return this.storage.transactionSync(() => {
      for (const round of set.rounds) {
        if (!this.exists("syntax_entries", round.entryId)) throw new SyntaxLibraryError(`Unknown entry ${round.entryId}.`);
      }
      this.write("syntax_sets", set.id, set, create);
      this.storage.sql.exec("DELETE FROM syntax_set_members WHERE set_id = ?", set.id);
      set.rounds.forEach((round, index) => this.storage.sql.exec("INSERT INTO syntax_set_members (set_id, entry_id, position) VALUES (?, ?, ?)", set.id, round.entryId, index));
      return set;
    });
  }
  deleteEntry(id: string): void {
    this.getEntry(id);
    if (this.storage.sql.exec("SELECT set_id FROM syntax_set_members WHERE entry_id = ? LIMIT 1", id).toArray().length) throw new SyntaxLibraryError("Entry is referenced by a saved set.", 409);
    this.storage.sql.exec("DELETE FROM syntax_entries WHERE id = ?", id);
  }
  deleteSet(id: string): void {
    this.storage.transactionSync(() => {
      this.getSet(id);
      this.storage.sql.exec("DELETE FROM syntax_set_members WHERE set_id = ?", id);
      this.storage.sql.exec("DELETE FROM syntax_sets WHERE id = ?", id);
    });
  }
  /** One synchronous transaction: no await/interleaving while reading the set,
   * validating every reviewed entry and retaining the independent launch copy.
   * Room runtime must supply askPlayMode from trusted room settings. */
  prepareSnapshot(setId: string, raw: unknown): SyntaxSessionSnapshot {
    const options = parseSyntaxObject(raw, "Launch options");
    return this.storage.transactionSync(() => {
      const id = parseSyntaxId(options.id, "Session");
      if (this.exists("syntax_snapshots", id)) throw new SyntaxLibraryError("Session id already exists.", 409);
      const saved = this.getSet(setId);
      const set = parseSyntaxSavedSet({ ...saved, submissionMode: options.submissionMode ?? saved.submissionMode });
      const entries = set.rounds.map(round => this.playable(this.getEntry(round.entryId)));
      const snapshot = prepareSyntaxSession(id, set, entries, Date.now(), options.askPlayMode as boolean).snapshot;
      this.storage.sql.exec("INSERT INTO syntax_snapshots (id, set_id, body) VALUES (?, ?, ?)", id, setId, serializeSyntaxSnapshot(snapshot));
      return snapshot;
    });
  }
  getSnapshot(id: string): SyntaxSessionSnapshot { return this.read("syntax_snapshots", parseSyntaxId(id)); }

  /** Only forwarded from authenticated admin routes; snapshots are internal-only. */
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      const imageChange = path.match(/^\/syntax\/entries\/([^/]+)\/image$/);
      if (imageChange && (request.method === "PUT" || request.method === "DELETE")) {
        const id = parseSyntaxId(decodeURIComponent(imageChange[1]));
        const entry = request.method === "PUT" ? this.attachImageRevision(id, await request.json()) : this.removeCurrentImage(id);
        // No targets, explanation, provenance or other answer metadata here.
        return Response.json({ ok: true, imageRevisionId: entry.imageRevisionId, image: entry.image, status: entry.status });
      }
      if (path === "/syntax/launchable-sets" && request.method === "GET") {
        const sets = this.listSets().filter(set => {
          try { set.rounds.forEach(round => this.playable(this.getEntry(round.entryId))); return true; }
          catch { return false; }
        }).map(set => ({ id: set.id, title: set.title, defaultDurationMs: set.defaultDurationMs, submissionMode: set.submissionMode, roundCount: set.rounds.length }));
        return Response.json(sets);
      }
      const match = path.match(/^\/syntax\/(entries|sets)(?:\/([^/]+))?$/);
      if (match) {
        const entries = match[1] === "entries";
        const id = match[2] ? parseSyntaxId(decodeURIComponent(match[2])) : null;
        if (request.method === "GET") return Response.json(id ? (entries ? this.getEntry(id) : this.getSet(id)) : (entries ? this.listEntries() : this.listSets()));
        if (request.method === "DELETE" && id) {
          if (entries) this.deleteEntry(id); else this.deleteSet(id);
          return Response.json({ ok: true });
        }
        if ((request.method === "POST" && !id) || (request.method === "PUT" && id)) {
          const raw = parseSyntaxObject(await request.json(), "Body");
          if (id && raw.id !== id) throw new SyntaxLibraryError("Body id must match route id.");
          const result = entries ? this.saveEntry(raw, !id) : this.saveSet(raw, !id);
          return Response.json(result, { status: id ? 200 : 201 });
        }
        return Response.json({ error: "Method not allowed." }, { status: 405 });
      }
      const launch = path.match(/^\/syntax\/sets\/([^/]+)\/snapshot$/);
      if (launch && request.method === "POST") return Response.json(this.prepareSnapshot(parseSyntaxId(decodeURIComponent(launch[1])), await request.json()), { status: 201 });
      const snapshot = path.match(/^\/syntax\/snapshots\/([^/]+)$/);
      if (snapshot && request.method === "GET") return Response.json(this.getSnapshot(decodeURIComponent(snapshot[1])));
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      if (error instanceof SyntaxLibraryError || error instanceof SyntaxError || (error instanceof Error && !(error.message.includes("SQLITE")))) {
        return Response.json({ error: error.message }, { status: error instanceof SyntaxLibraryError ? error.status : 400 });
      }
      throw error;
    }
  }
}
