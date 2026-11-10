import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { SyntaxRuntimeStore } from "../src/syntax-game/storage-runtime.ts";
import { SyntaxRuntime } from "../src/syntax-game/runtime.ts";
import { prepareSyntaxSession } from "../src/syntax-game/session.ts";
import { syntaxRoundId } from "../src/syntax-game/protocol.ts";
import { historyId, historyPagination, syntaxHistoryStandings } from "../src/syntax-game/history.ts";
import { routeSyntaxHistoryHttp, handleInternalSyntaxHistory } from "../src/syntax-game/history-http.ts";

function backing() {
  const db = new DatabaseSync(":memory:");
  return {
    db, sql: { exec(query, ...args) { const rows = db.prepare(query).all(...args); return { toArray: () => rows }; } },
    transactionSync(fn) { db.exec("BEGIN"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } },
    async setAlarm() {}, async deleteAlarm() {},
  };
}
const player = { id: "disconnected", name: "Original player", playMode: "online" };
const entry = { id: "entry", title: "Original screenshot", image: { url: "/api/syntax/images/immutable-revision", width: 400, height: 200, alt: "Code" }, targets: [{ x: .25, y: .5, radius: .05 }], explanation: "Original answer" };
const set = { id: "set", title: "Original set", defaultDurationMs: 1000, submissionMode: "confirm", rounds: [{ entryId: "entry" }] };
function session(id, phase = "finished") {
  return { ...prepareSyntaxSession(id, set, [entry], 100, true), phase, players: [player], answers: [{ playerId: player.id, roundIndex: 0, point: { x: .25, y: .5 }, correct: true, points: 900, elapsedMs: 100, receivedAt: 200 }], revealedRoundIndexes: phase === "finished" ? [0] : [] };
}

test("IDs and pagination are decoded once, bounded and reject malformed/duplicate parameters", () => {
  assert.equal(historyId("room-123_ABC"), "room-123_ABC");
  for (const id of ["%", "%2f", "%252f", "..", "a.b", "a".repeat(129), "%00", ""]) assert.equal(historyId(id), null, id);
  assert.deepEqual(historyPagination(new URLSearchParams()), { limit: 20, offset: 0 });
  assert.deepEqual(historyPagination(new URLSearchParams("limit=50&offset=100000")), { limit: 50, offset: 100000 });
  for (const query of ["limit=0", "limit=51", "offset=-1", "offset=100001", "offset=1.5", "limit=1e1", "offset=0&offset=1", "limit=", "offset=Infinity"]) assert.equal(historyPagination(new URLSearchParams(query)), null, query);
});

test("history list is paged, stable on active writes, and contains only safe bounded summaries", () => {
  const storage = backing(), store = new SyntaxRuntimeStore(storage);
  for (let i = 0; i < 53; i++) store.save({ mode: "syntax", generation: i, session: session(`game-${i}`) });
  store.save({ mode: "poll", generation: 54, session: { ...session("game-0"), snapshot: { ...session("game-0").snapshot, title: "x".repeat(1000) } } });
  const first = store.listHistory({ limit: 20, offset: 0 });
  assert.equal(first.games.length, 20); assert.equal(first.nextOffset, 20); assert.equal(first.games[0].id, "game-52");
  const ids = [...first.games, ...store.listHistory({ limit: 20, offset: 20 }).games, ...store.listHistory({ limit: 20, offset: 40 }).games].map(row => row.id);
  assert.equal(new Set(ids).size, 53);
  assert.equal(store.listHistory({ limit: 20, offset: 40 }).nextOffset, null);
  assert.equal(store.listHistory({ limit: 20, offset: 53 }).games.length, 0);
  const last = store.listHistory({ limit: 20, offset: 40 }).games.at(-1);
  assert.equal(last.title.length, 240);
  assert.deepEqual(Object.keys(last).sort(), ["id", "title", "preparedAt", "phase", "submissionMode", "rounds", "revealedRounds", "participants"].sort());
  assert.ok(!JSON.stringify(first).includes("targets")); assert.ok(!JSON.stringify(first).includes(player.name));
  for (const page of [{ limit: 51, offset: 0 }, { limit: 1, offset: -1 }]) assert.throws(() => store.listHistory(page));
});

test("protected forwarding rejects unauthorized/host-only users, malformed IDs, writes and bad pages before touching room storage", async () => {
  let calls = [];
  const store = new SyntaxRuntimeStore(backing()); store.save({ mode: "syntax", generation: 1, session: session("game") });
  const deps = { checkAdminAuth: req => req.headers.get("x-admin-key") === "test-only" ? null : new Response("Unauthorized", { status: 401 }), roomFetch: async (room, path) => { calls.push({ room, path }); return handleInternalSyntaxHistory(new Request(`http://internal${path}`), store); } };
  const request = (path, auth = true, method = "GET") => new Request(`http://example/api/admin/rooms/${path}`, { method, headers: auth ? { "x-admin-key": "test-only" } : { "hostKey": "host-only" } });
  assert.equal((await routeSyntaxHistoryHttp(request("room/syntax/history/game", false), deps)).status, 401);
  assert.equal(calls.length, 0);
  for (const path of ["%ZZ/syntax/history", "room/syntax/history/%2F", "room/syntax/history?limit=99", "room/syntax/history?offset=-1"]) assert.equal((await routeSyntaxHistoryHttp(request(path), deps)).status, 400);
  assert.equal((await routeSyntaxHistoryHttp(request("room/syntax/history", true, "DELETE"), deps)).status, 405);
  assert.equal(calls.length, 0);
  const list = await routeSyntaxHistoryHttp(request("room/syntax/history?limit=1"), deps);
  assert.equal(list.headers.get("cache-control"), "no-store"); assert.equal((await list.json()).games.length, 1);
  const detail = await routeSyntaxHistoryHttp(request("room/syntax/history/game"), deps);
  assert.deepEqual((await detail.json()).session.snapshot.rounds[0].entry.targets, entry.targets);
  assert.equal((await routeSyntaxHistoryHttp(request("room/syntax/history/missing"), deps)).status, 404);
  assert.deepEqual(calls[0], { room: "room", path: "/syntax/history?limit=1" });
});

test("two real games, poll switch, source replacement/deletion and reload preserve exact snapshots, identity and results", async () => {
  const storage = backing(); let now = 100, library = structuredClone(entry);
  const loadSnapshot = async (_, options) => prepareSyntaxSession(options.id, { ...set, submissionMode: options.submissionMode }, [library], now, options.askPlayMode).snapshot;
  let runtime = new SyntaxRuntime(storage, loadSnapshot, () => {}, () => now);
  const command = type => runtime.command({ type: `syntax:${type}`, gameId: runtime.session.snapshot.id, roundId: syntaxRoundId(runtime.session.snapshot.id, runtime.session.roundIndex) }, "host", true);
  await runtime.command({ type: "syntax:launch", setId: "set", submissionMode: "confirm" }, "host", true, [player]);
  const firstId = runtime.session.snapshot.id;
  await command("open"); await runtime.answer({ type: "syntax:answer", gameId: firstId, roundId: syntaxRoundId(firstId, 0), point: { x: .25, y: .5 } }, { role: "audience", voterId: player.id }, 200);
  now = 1100; await runtime.reconcile(); await command("reveal"); await command("finish");
  const firstSaved = new SyntaxRuntimeStore(storage).history(firstId);
  await command("polls");
  library = { ...library, title: "Changed", targets: [{ x: .8, y: .2, radius: .1 }], image: { ...library.image, url: "/new-revision" } };
  now = 2000;
  await runtime.command({ type: "syntax:launch", setId: "set", submissionMode: "first-click" }, "host", true, [player]);
  const secondId = runtime.session.snapshot.id;
  await command("open"); await runtime.answer({ type: "syntax:answer", gameId: secondId, roundId: syntaxRoundId(secondId, 0), point: { x: .8, y: .2 } }, { role: "audience", voterId: player.id }, 2100);
  await command("abort"); await command("polls"); library = null;
  runtime = new SyntaxRuntime(storage, loadSnapshot, () => {}, () => now);
  await runtime.reconcile();
  const reloaded = new SyntaxRuntimeStore(storage);
  assert.deepEqual(reloaded.history(firstId), firstSaved);
  assert.equal(reloaded.history(firstId).snapshot.rounds[0].entry.image.url, entry.image.url);
  assert.deepEqual(reloaded.history(firstId).players, [player]);
  assert.equal(reloaded.history(secondId).phase, "aborted");
  assert.equal(reloaded.history(secondId).snapshot.rounds[0].entry.image.url, "/new-revision");
  assert.equal(syntaxHistoryStandings(reloaded.history(firstId))[0].standings[0].points, 900);
  assert.equal(syntaxHistoryStandings(reloaded.history(secondId))[0].standings[0].points, 0);
  assert.equal(reloaded.history(secondId).answers[0].points, 900);
  assert.equal(reloaded.listHistory({ limit: 20, offset: 0 }).games.length, 2);
});

test("internal reads never write session state and aborted scores include revealed rounds only", async () => {
  const storage = backing(), store = new SyntaxRuntimeStore(storage);
  const saved = session("aborted", "aborted"); store.save({ mode: "poll", generation: 1, session: saved });
  const before = JSON.stringify(store.load());
  assert.equal(handleInternalSyntaxHistory(new Request("http://internal/syntax/history/aborted"), store).status, 200);
  assert.equal(handleInternalSyntaxHistory(new Request("http://internal/syntax/history/aborted", { method: "POST" }), store).status, 405);
  assert.equal(JSON.stringify(store.load()), before);
  assert.equal(syntaxHistoryStandings(saved)[0].standings[0].points, 0);
  assert.equal(syntaxHistoryStandings({ ...saved, revealedRoundIndexes: [0] })[0].standings[0].points, 900);
});

test("worker uses existing admin auth; external PartyServer history HTTP and upgrades cannot bypass it", async () => {
  const fake = code => ({ url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true });
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "@tanstack/react-start/server-entry") return fake("export default { fetch: async () => new Response('app') }");
    if (specifier === "partyserver") return fake("export const routePartykitRequest = async () => new Response('party');");
    if (specifier === "./poll-room") return fake("export const STARTER_QUESTIONS=[]; export class PollRoom {};");
    if (specifier === "./admin-registry") return fake("export class AdminRegistry {};");
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
    return next(specifier, context);
  } });
  try {
    const { default: worker } = await import("../src/server.ts");
    const calls = [];
    const env = { ADMIN_KEY: "test-only", PollRoom: { idFromName: n => n, get: id => ({ fetch: async req => { calls.push([id, req.url, req.headers.get("x-partykit-room")]); return Response.json({ games: [], nextOffset: null }); } }) } };
    const fetch = (path, headers) => worker.fetch(new Request(`http://example${path}`, { headers }), env, {});
    assert.equal((await fetch("/api/admin/rooms/room/syntax/history")).status, 401);
    assert.equal((await fetch("/api/admin/rooms/room/syntax/history?hostKey=host")).status, 401);
    assert.equal((await fetch("/api/admin/rooms/room/syntax/history", { "x-admin-key": "test-only" })).status, 200);
    assert.deepEqual(calls, [["room", "http://internal/syntax/history", "room"]]);
    assert.equal((await fetch("/parties/poll-room/room/syntax/history")).status, 404);
    assert.equal((await fetch("/parties/poll-room/room/syntax/history", { upgrade: "websocket" })).status, 200); // party negotiation, never internal HTTP dispatch
    assert.equal(calls.length, 1);
  } finally { hooks.deregister(); }
});

test("actual internal PollRoom history reads, poll reset and registry deletion retain saved games", async () => {
  const fake = code => ({ url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true });
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "partyserver") return fake(`export class Server {
      constructor(ctx,env) { this.ctx=ctx;this.env=env;this.name='room'; }
      getConnections() { return [].values(); }
      sql(strings,...args) { return this.ctx.storage.sql.exec(strings.join('?'),...args).toArray(); }
    }`);
    if (specifier === "cloudflare:workers") return fake("export class DurableObject { constructor(ctx,env) { this.ctx=ctx;this.env=env; } }");
    if (specifier === "./poll-images") return fake("export const loadOptionImages=async()=>({});export const listRoomImages=async()=>({});export const deleteUnusedRoomImages=async()=>{};");
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
    return next(specifier, context);
  } });
  try {
    const { PollRoom } = await import("../src/poll-room.ts");
    const { AdminRegistry } = await import("../src/admin-registry.ts");
    const storage = backing(), store = new SyntaxRuntimeStore(storage);
    const saved = session("game"); store.save({ mode: "poll", generation: 1, session: saved });
    let room = new PollRoom({ storage }, {});
    await room.onStart();
    assert.equal((await room.onRequest(new Request("http://internal/reset", { method: "POST" }))).status, 200);
    assert.deepEqual(store.history("game"), saved);
    const registryStorage = backing(), registry = new AdminRegistry({ storage: registryStorage }, {});
    assert.equal((await registry.fetch(new Request("http://internal/rooms", { method: "POST", body: JSON.stringify({ name: "room", hostKey: "test-only-host" }) }))).status, 200);
    assert.equal((await registry.fetch(new Request("http://internal/rooms/room", { method: "DELETE" }))).status, 200);
    assert.deepEqual(await (await registry.fetch(new Request("http://internal/rooms"))).json(), []);
    room = new PollRoom({ storage }, {});
    const response = await room.onRequest(new Request("http://internal/syntax/history/game"));
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).session, saved);
    assert.equal((await room.onRequest(new Request("http://internal/syntax/history?limit=0"))).status, 400);
    assert.equal((await room.onRequest(new Request("http://internal/syntax/history/game", { method: "DELETE" }))).status, 405);
    assert.deepEqual(store.history("game"), saved);
    // A read does not itself reconcile a live deadline or reveal/abort a round.
    const open = { ...saved, phase: "open", timing: { openedAt: 100, deadlineAt: 1100 }, revealedRoundIndexes: [] };
    store.save({ mode: "syntax", generation: 2, session: open });
    room = new PollRoom({ storage }, {});
    await room.onRequest(new Request("http://internal/syntax/history/game"));
    assert.equal(store.history("game").phase, "open");
  } finally { hooks.deregister(); }
});
