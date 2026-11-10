import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureSyntaxLibrarySchema, SyntaxLibraryStore } from "../src/syntax-game/library.ts";
import { routeSyntaxLibraryHttp } from "../src/syntax-game/library-http.ts";

function storage(db = new DatabaseSync(":memory:")) {
  return {
    db,
    sql: { exec(query, ...args) {
      const stmt = db.prepare(query);
      return { toArray() { return stmt.all(...args); } };
    } },
    transactionSync(fn) {
      db.exec("BEGIN");
      try { const result = fn(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}
// Cloudflare executes SQL eagerly; preserve that contract in the Node adapter.
function persisted(db) {
  const value = storage(db);
  value.sql.exec = (query, ...args) => {
    const rows = value.db.prepare(query).all(...args);
    return { toArray: () => rows };
  };
  ensureSyntaxLibrarySchema(value.sql);
  return value;
}
function fixture(db) {
  const backing = persisted(db);
  return { backing, store: new SyntaxLibraryStore(backing) };
}
function entry(id = "entry", overrides = {}) {
  return { id, title: "Find the bug", language: "typescript", status: "draft", targets: [], ...overrides };
}
function reviewed(store, id = "entry", rev = "rev1") {
  store.registerImageRevision({ id: rev, entryId: id, key: `syntax/${id}/${rev}`, image: { url: `/api/syntax/images/${id}/${rev}`, width: 640, height: 320, alt: "Code screenshot" } });
  return entry(id, { status: "reviewed", imageRevisionId: rev, targets: [{ x: 0.3, y: 0.2, radius: 0.05 }] });
}
function set(rounds = [{ entryId: "entry" }], overrides = {}) {
  return { id: "set", title: "Conference", defaultDurationMs: 30000, submissionMode: "first-click", rounds, ...overrides };
}
async function api(store, path, method = "GET", body) {
  return store.fetch(new Request(`http://internal/syntax/${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}

test("draft CRUD, parser errors and launch gating", async () => {
  const { store } = fixture();
  assert.equal((await api(store, "entries", "POST", entry())).status, 201);
  assert.equal((await api(store, "entries", "POST", entry())).status, 409);
  assert.equal(store.getEntry("entry").image, null);
  assert.equal((await api(store, "entries/missing")).status, 404);
  assert.equal((await api(store, "entries/entry", "PUT", entry("other"))).status, 400);
  assert.equal((await api(store, "entries/entry", "PUT", entry("entry", { targets: [{ x: 2, y: 0, radius: 1 }] }))).status, 400);
  assert.equal((await api(store, "entries/entry", "PUT", entry("entry", { status: "reviewed" }))).status, 409);
  assert.equal((await api(store, "sets", "POST", set())).status, 201);
  assert.equal((await api(store, "sets/set/snapshot", "POST", { id: "session", askPlayMode: true })).status, 409);
  assert.deepEqual(await (await api(store, "launchable-sets")).json(), []);
  assert.equal((await api(store, "entries/entry", "DELETE")).status, 409);
  assert.equal((await api(store, "sets/set", "DELETE")).status, 200);
  assert.equal((await api(store, "entries/entry", "DELETE")).status, 200);
  assert.equal((await api(store, "entries/entry", "DELETE")).status, 404);
  assert.equal((await store.fetch(new Request("http://internal/syntax/entries", { method: "POST", body: "{" }))).status, 400);
});

test("sets reject empty, duplicate, unknown membership and invalid timing; retain order and overrides", async () => {
  const { store } = fixture();
  store.saveEntry(entry(), true);
  store.saveEntry(entry("second"), true);
  for (const bad of [set([]), set([{ entryId: "entry" }, { entryId: "entry" }]), set([{ entryId: "unknown" }]), set([{ entryId: "entry", durationMs: 999 }]), set(undefined, { defaultDurationMs: 300001 }), set(undefined, { submissionMode: "invalid" })]) {
    assert.equal((await api(store, "sets", "POST", bad)).status, 400);
  }
  const ordered = set([{ entryId: "second", durationMs: 2000 }, { entryId: "entry" }]);
  store.saveSet(ordered, true);
  assert.deepEqual(store.getSet("set"), ordered);
  assert.equal((await api(store, "sets", "POST", ordered)).status, 409);
  assert.equal((await api(store, "sets/missing", "PUT", { ...ordered, id: "missing" })).status, 404);
  const badUpdate = set([{ entryId: "unknown" }]);
  assert.equal((await api(store, "sets/set", "PUT", badUpdate)).status, 400);
  assert.deepEqual(store.getSet("set"), ordered);
  store.saveSet(set(), false);
  store.deleteEntry("second"); // Membership index was replaced, not appended.
});

test("append-only immutable images, atomic launch snapshots, launch mode override and retained history", async () => {
  const { store } = fixture();
  store.saveEntry(reviewed(store), true);
  store.saveEntry(reviewed(store, "second", "rev2"), true);
  store.saveSet(set([{ entryId: "second", durationMs: 1234 }, { entryId: "entry" }]), true);
  const options = { id: "session", askPlayMode: true, submissionMode: "confirm" };
  const snapshot = store.prepareSnapshot("set", options);
  assert.equal(snapshot.submissionMode, "confirm");
  assert.equal(store.getSet("set").submissionMode, "first-click");
  assert.deepEqual(snapshot.rounds.map(round => [round.entry.id, round.durationMs]), [["second", 1234], ["entry", 30000]]);
  assert.throws(() => store.prepareSnapshot("set", options), /already exists/);
  assert.throws(() => store.prepareSnapshot("set", { id: "invalid", askPlayMode: "true" }), /boolean/);
  assert.throws(() => store.getSnapshot("invalid"), /Not found/);
  const revision = { id: "rev1", entryId: "entry", key: "syntax/entry/rev1", image: { url: "/api/syntax/images/entry/rev1", width: 640, height: 320, alt: "Code screenshot" } };
  assert.deepEqual(store.registerImageRevision(revision), revision);
  assert.throws(() => store.registerImageRevision({ ...revision, image: { ...revision.image, width: 641 } }), /immutable/);
  assert.throws(() => store.registerImageRevision({ ...revision, key: "polls/mutable" }), /namespace/);
  assert.throws(() => store.saveEntry(entry("second", { imageRevisionId: "rev1" }), false), /another entry/);
  store.saveEntry(entry("entry", { title: "Edited draft" }), false);
  store.deleteSet("set");
  store.deleteEntry("entry");
  store.deleteEntry("second");
  assert.deepEqual(store.getSnapshot("session"), snapshot);
  assert.ok(Object.isFrozen(snapshot.rounds[0].entry.targets));
});

test("repeatable additive schema and on-disk reload persistence", () => {
  const dir = mkdtempSync("/tmp/opencode/syntax-library-");
  const path = join(dir, "test.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE rooms (name TEXT PRIMARY KEY, host_key TEXT NOT NULL, created_at TEXT, start_at TEXT); INSERT INTO rooms VALUES ('existing', 'secret', 'yesterday', 'today')");
    const { store, backing } = fixture(db);
    ensureSyntaxLibrarySchema(backing.sql);
    store.saveEntry(reviewed(store), true);
    store.saveSet(set(), true);
    store.prepareSnapshot("set", { id: "session", askPlayMode: false });
    db.close();
    const reload = fixture(new DatabaseSync(path));
    assert.equal(reload.store.getEntry("entry").status, "reviewed");
    assert.equal(reload.store.getSet("set").rounds[0].entryId, "entry");
    assert.equal(reload.store.getSnapshot("session").askPlayMode, false);
    assert.equal(reload.backing.sql.exec("SELECT host_key FROM rooms WHERE name = ?", "existing").toArray()[0].host_key, "secret");
    reload.backing.db.close();
  } finally { rmSync(dir, { recursive: true }); }
});

test("HTTP admin boundary and room-host boundary; no public targets or internal snapshot forwarding", async () => {
  const { store } = fixture();
  store.saveEntry(reviewed(store), true);
  store.saveSet(set(), true);
  const deps = {
    checkAdminAuth(request) {
      const query = new URL(request.url).searchParams;
      return request.headers.get("x-admin-key") === "admin" || query.get("adminKey") === "admin" ? null : new Response("Unauthorized", { status: 401 });
    },
    lookupHostKey: async room => room === "room" ? "room-key" : null,
    defaultHostKey: "default-key",
    registryFetch: request => store.fetch(request),
  };
  const call = (path, headers = {}, method = "GET") => routeSyntaxLibraryHttp(new Request(`http://worker${path}`, { headers, method }), deps);
  assert.equal((await call("/api/admin/syntax/entries")).status, 401);
  assert.equal((await call("/api/admin/syntax/entries", { "x-admin-key": "wrong" })).status, 401);
  assert.equal((await call("/api/admin/syntax/entries?adminKey=admin")).status, 200);
  assert.equal((await call("/api/admin/syntax/entries", { "x-admin-key": "admin" })).status, 200);
  assert.equal((await call("/api/admin/syntax/sets/set/snapshot", { "x-admin-key": "admin" }, "POST")).status, 404);
  assert.equal((await call("/api/admin/syntax/snapshots/session", { "x-admin-key": "admin" })).status, 404);
  assert.equal((await call("/api/rooms/room/syntax/sets")).status, 401);
  assert.equal((await call("/api/rooms/room/syntax/sets?hostKey=default-key")).status, 401);
  const host = await call("/api/rooms/room/syntax/sets?hostKey=room-key");
  assert.equal(host.status, 200);
  assert.equal(host.headers.get("cache-control"), "no-store");
  assert.deepEqual(await host.json(), [{ id: "set", title: "Conference", defaultDurationMs: 30000, submissionMode: "first-click", roundCount: 1 }]);
  assert.equal((await call("/api/rooms/new/syntax/sets", { "x-host-key": "default-key" })).status, 200);
  assert.equal((await call("/api/rooms/room/syntax/sets", { "x-host-key": "room-key" }, "POST")).status, 405);
  assert.equal(await call("/api/syntax/entries"), null);
  assert.equal(await call("/api/rooms/room/settings"), null);
});

test("AdminRegistry still supports room CRUD alongside library and repeat initialization", async () => {
  const mock = `export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }`;
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: `data:text/javascript,${encodeURIComponent(mock)}`, shortCircuit: true };
    if (specifier === "./syntax-game/library") return next(new URL("../src/syntax-game/library.ts", import.meta.url).href, context);
    return next(specifier, context);
  } });
  try {
    const { AdminRegistry } = await import("../src/admin-registry.ts");
    const backing = persisted();
    let registry = new AdminRegistry({ storage: backing }, {});
    const request = (path, method = "GET", body) => new Request(`http://internal${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await registry.fetch(request("/rooms", "POST", { name: "room", hostKey: "secret" }))).status, 200);
    assert.equal((await registry.fetch(request("/syntax/entries", "POST", entry()))).status, 201);
    registry = new AdminRegistry({ storage: backing }, {});
    const rooms = await (await registry.fetch(request("/rooms"))).json();
    assert.equal(rooms[0].host_key, "secret");
    assert.equal((await (await registry.fetch(request("/syntax/entries"))).json()).length, 1);
    assert.equal((await (await registry.fetch(request("/rooms/room/host-key"))).json()).hostKey, "secret");
    assert.equal((await registry.fetch(request("/rooms/room", "DELETE"))).status, 200);
    assert.deepEqual(await (await registry.fetch(request("/rooms"))).json(), []);
  } finally { hook.deregister(); }
});
