import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { SyntaxRuntime } from "../src/syntax-game/runtime.ts";
import { parseSyntaxCommand, syntaxRoundId } from "../src/syntax-game/protocol.ts";
import { prepareSyntaxSession } from "../src/syntax-game/session.ts";
import { projectSyntaxSession, buildSyntaxSharedProjection, projectSyntaxClickPage, SYNTAX_CLICK_PAGE_SIZE, SYNTAX_STANDINGS_LIMIT } from "../src/syntax-game/projections.ts";
import { SyntaxRuntimeStore } from "../src/syntax-game/storage-runtime.ts";

function backing() {
  const db = new DatabaseSync(":memory:");
  return {
    db, alarm: null, failSave: false, alarms: [],
    sql: { exec(query, ...args) {
      const rows = db.prepare(query).all(...args);
      return { toArray: () => rows };
    } },
    transactionSync(fn) {
      db.exec("BEGIN");
      try {
        if (this.failSave) throw new Error("SQL failure");
        const value = fn(); db.exec("COMMIT"); return value;
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    async setAlarm(time) { this.alarms.push(time); this.alarm = time; },
    async deleteAlarm() { this.alarm = null; },
  };
}
const player = { id: "voter", name: "Original name", playMode: "online" };
function snapshot(id, askPlayMode = true, submissionMode = "confirm", rounds = 2) {
  return prepareSyntaxSession(id, {
    id: "set", title: "Conference", defaultDurationMs: 1000, submissionMode,
    rounds: Array.from({ length: rounds }, (_, i) => ({ entryId: `entry${i}` })),
  }, Array.from({ length: rounds }, (_, i) => ({
    id: `entry${i}`, title: "Code", image: { url: `/immutable/rev${i}`, width: 400, height: 200, alt: "Code" },
    targets: [{ x: 0.25, y: 0.5, radius: 0.05 }], explanation: "secret explanation",
  })), 100, askPlayMode).snapshot;
}
function fixture(storage = backing(), snapshotFetch) {
  let now = 100;
  let broadcasts = 0;
  const runtime = new SyntaxRuntime(storage, snapshotFetch ?? (async (_, options) => snapshot(options.id, options.askPlayMode, options.submissionMode)), () => broadcasts++, () => now);
  const launch = () => runtime.command({ type: "syntax:launch", setId: "set", submissionMode: "confirm" }, "host", true, [player]);
  const command = (type, role = "host") => runtime.command({ type: `syntax:${type}`, gameId: runtime.session?.snapshot.id, roundId: runtime.session ? syntaxRoundId(runtime.session.snapshot.id, runtime.session.roundIndex) : "none" }, role, true);
  const answer = (point, receivedAt, identity = { role: "audience", voterId: "voter" }, overrides = {}) => runtime.answer({ type: "syntax:answer", gameId: runtime.session?.snapshot.id, roundId: runtime.session ? syntaxRoundId(runtime.session.snapshot.id, runtime.session.roundIndex) : "none", point, ...overrides }, identity, receivedAt);
  return { runtime, storage, launch, command, answer, setNow: n => now = n, broadcasts: () => broadcasts };
}

test("lifecycle, role authorization, explicit reveal/next/finish and retained history", async () => {
  const f = fixture();
  await assert.rejects(() => f.runtime.command({ type: "syntax:launch", setId: "set", submissionMode: "confirm" }, "audience", true), /host/);
  await f.launch();
  const firstId = f.runtime.session.snapshot.id;
  assert.equal(f.runtime.mode, "syntax");
  assert.equal(f.runtime.session.phase, "prepared");
  await assert.rejects(f.command("reveal"), /closed/);
  await assert.rejects(f.command("polls"), /abort/);
  await assert.rejects(f.launch(), /already active/);
  await assert.rejects(f.command("open", "projector"), /host/);
  await f.command("open");
  assert.equal(f.storage.alarm, 1100);
  await assert.rejects(f.command("open"), /prepared/);
  await assert.rejects(f.command("reveal"), /timer/);
  f.setNow(1100);
  await f.runtime.reconcile();
  assert.equal(f.runtime.session.phase, "closed");
  assert.equal(f.storage.alarm, null);
  await f.command("reveal");
  await assert.rejects(f.command("finish"), /final/);
  const oldRound = syntaxRoundId(firstId, 0);
  await f.command("next");
  assert.equal(f.runtime.session.phase, "prepared");
  await assert.rejects(f.runtime.command({ type: "syntax:open", gameId: firstId, roundId: oldRound }, "host", true), /Stale/);
  await f.command("open");
  await assert.rejects(f.command("close"), /Unsupported/);
  f.setNow(f.runtime.session.timing.deadlineAt); await f.runtime.reconcile(); await f.command("reveal");
  await assert.rejects(f.command("next"), /finish/);
  await f.command("finish");
  await f.command("polls");
  await assert.rejects(f.command("open"), /inactive/);
  await f.launch();
  const history = f.storage.sql.exec("SELECT data FROM syntax_history WHERE id=?", firstId).toArray();
  assert.equal(JSON.parse(history[0].data).phase, "finished");
  assert.equal(f.storage.sql.exec("SELECT count(*) AS n FROM syntax_history").toArray()[0].n, 2);
});

test("reload/hibernation late alarm closes only; membership and poll tables survive", async () => {
  const f = fixture();
  f.storage.sql.exec("CREATE TABLE room_vote(data TEXT)");
  f.storage.sql.exec("INSERT INTO room_vote VALUES ('preserved')");
  await f.launch(); await f.command("open");
  const reload = fixture(f.storage);
  reload.setNow(500000);
  await reload.runtime.reconcile();
  assert.equal(reload.runtime.session.phase, "closed");
  assert.equal(reload.runtime.session.roundIndex, 0);
  assert.deepEqual(reload.runtime.session.revealedRoundIndexes, []);
  await reload.runtime.join({ ...player, name: "Changed", playMode: "in-person" });
  await reload.runtime.join({ id: "late", name: "Late join", playMode: "in-person" });
  assert.deepEqual(reload.runtime.session.players[0], player);
  assert.equal(reload.runtime.session.players.length, 2);
  assert.equal(f.storage.sql.exec("SELECT data FROM room_vote").toArray()[0].data, "preserved");
  await reload.command("abort");
  assert.deepEqual(reload.runtime.session.revealedRoundIndexes, []);
  await reload.command("polls");
});

test("concurrent launches, generation cancellation, one atomic registry read", async () => {
  let release, requests = [];
  const f = fixture(backing(), (_, options) => {
    requests.push(options);
    return new Promise(resolve => release = () => resolve(snapshot(options.id, options.askPlayMode, options.submissionMode)));
  });
  const pending = f.launch();
  await assert.rejects(f.launch(), /already active/);
  await f.command("polls"); // invalidate snapshot in flight
  release();
  await assert.rejects(pending, /superseded/);
  assert.equal(f.runtime.mode, "poll");
  assert.equal(f.runtime.session, null);
  assert.equal(requests.length, 1);
  const retry = f.launch(); release(); await retry;
  assert.equal(f.runtime.session.snapshot.submissionMode, "confirm");
});

test("pre-arm before OPEN commit and finally repair after storage/arm failure", async () => {
  const f = fixture(); await f.launch();
  f.storage.failSave = true;
  await assert.rejects(f.command("open"), /SQL failure/);
  assert.deepEqual(f.storage.alarms, [1100]);
  assert.equal(f.storage.alarm, null);
  assert.equal(f.runtime.session.phase, "prepared");
  f.storage.failSave = false;
  const setAlarm = f.storage.setAlarm.bind(f.storage);
  f.storage.setAlarm = async () => { throw new Error("arm failure"); };
  await assert.rejects(f.command("open"), /arm failure/);
  assert.equal(f.runtime.session.phase, "prepared");
  f.storage.setAlarm = setAlarm;
  await f.command("open");
  assert.equal(JSON.parse(f.storage.sql.exec("SELECT data FROM syntax_runtime").toArray()[0].data).session.phase, "open");
});

test("public prepared/open/closed state never leaks targets or unrevealed explanation", async () => {
  const f = fixture(); await f.launch();
  for (const phase of ["prepared", "open", "closed"]) {
    assert.equal(f.runtime.session.phase, phase);
    const serialized = JSON.stringify(projectSyntaxSession(f.runtime.session, "voter"));
    assert.ok(!serialized.includes("targets")); assert.ok(!serialized.includes("secret explanation"));
    if (phase === "prepared") await f.command("open");
    else if (phase === "open") { f.setNow(f.runtime.session.timing.deadlineAt); await f.runtime.reconcile(); }
  }
  await f.command("reveal");
  assert.ok(JSON.stringify(projectSyntaxSession(f.runtime.session)).includes("secret explanation"));
  assert.throws(() => parseSyntaxCommand({ type: "syntax:open" }), /required/);
  assert.throws(() => parseSyntaxCommand({ type: "syntax:answer", gameId: "game", roundId: "round" }), /point/i);
});

test("authoritative answer, safe ack, same-point replay and conflicting duplicate across tabs/reload", async () => {
  const f = fixture(); await f.launch(); await f.command("open");
  const point = { x: 0.25, y: 0.5 };
  const [accepted, replayed] = await Promise.all([f.answer(point, 200), f.answer(point, 250)]);
  assert.equal(accepted.status, "accepted"); assert.equal(replayed.status, "replayed");
  assert.deepEqual(accepted.receipt, replayed.receipt);
  assert.equal(accepted.receipt.receivedAt, 200); assert.equal(accepted.receipt.elapsedMs, 100);
  assert.ok(!JSON.stringify(accepted).includes("correct")); assert.ok(!JSON.stringify(accepted).includes("points"));
  await assert.rejects(f.answer({ x: 0, y: 0 }, 300), e => e.code === "already-submitted");
  assert.equal(f.runtime.session.answers.length, 1);
  assert.equal(f.runtime.session.answers[0].points, 900);
  const stored = JSON.parse(f.storage.sql.exec("SELECT data FROM syntax_answers").toArray()[0].data);
  assert.deepEqual(stored.player, player); assert.equal(stored.answer.elapsedMs, 100);
  const reload = fixture(f.storage); reload.setNow(2000);
  await reload.runtime.join({ ...player, name: "Impersonated rename", playMode: "in-person" });
  assert.deepEqual((await reload.answer(point, 2000)).receipt, accepted.receipt);
  assert.deepEqual(reload.runtime.session.players[0], player);
  await assert.rejects(reload.answer({ x: 0, y: 0 }, 2000), e => e.code === "already-submitted");
  // Verify uniqueness is an actual storage constraint, not just an array check.
  const store = new SyntaxRuntimeStore(f.storage);
  assert.throws(() => store.save({ mode: "syntax", generation: 1, session: f.runtime.session }, stored), /UNIQUE/);
  assert.equal(f.storage.sql.exec("SELECT count(*) n FROM syntax_answers").toArray()[0].n, 1);
});

test("receipt boundary survives late queue/alarm closure but never reveal/advance/abort", async () => {
  const f = fixture(); await f.launch(); await f.command("open");
  await f.runtime.join({ id: "deadline", name: "Deadline", playMode: "online" });
  f.setNow(5000); await f.runtime.reconcile();
  assert.equal(f.runtime.session.phase, "closed");
  await assert.rejects(f.runtime.command({ type: "syntax:reveal", gameId: f.runtime.session.snapshot.id, roundId: syntaxRoundId(f.runtime.session.snapshot.id, 0) }, "host", true, [], 500), /timer/);
  // The receipt was during [100,1100), even though processing is much later.
  const valid = await f.answer({ x: 0.25, y: 0.5 }, 1099);
  assert.equal(valid.status, "accepted");
  await assert.rejects(f.answer({ x: 0, y: 0 }, 1100, { role: "audience", voterId: "deadline" }), e => e.code === "not-open");
  await assert.rejects(f.answer({ x: 0, y: 0 }, 99, { role: "audience", voterId: "deadline" }), e => e.code === "not-open");
  await f.command("reveal");
  await assert.rejects(f.answer({ x: 0.25, y: 0.5 }, 200, { role: "audience", voterId: "deadline" }), e => e.code === "not-open");
  assert.equal((await f.answer({ x: 0.25, y: 0.5 }, 5000)).status, "replayed");
  const old = { gameId: f.runtime.session.snapshot.id, roundId: syntaxRoundId(f.runtime.session.snapshot.id, 0) };
  await f.command("next"); await f.command("open");
  await assert.rejects(f.answer({ x: 0, y: 0 }, 5001, undefined, old), e => e.code === "stale-round");
  await f.command("abort");
  await assert.rejects(f.answer({ x: 0, y: 0 }, 5001), e => e.code === "not-open");
  await f.command("polls");
  await assert.rejects(f.answer({ x: 0, y: 0 }, 5001), e => e.code === "inactive-mode");
});

test("malicious answer payloads, roles/identity, prepared phase, stale IDs and ignored client claims", async () => {
  const f = fixture(); await f.launch();
  await assert.rejects(f.answer({ x: 0, y: 0 }, 100), e => e.code === "not-open");
  await f.command("open");
  for (const role of ["host", "projector"]) await assert.rejects(f.answer({ x: 0, y: 0 }, 200, { role, voterId: "voter" }), e => e.code === "forbidden");
  await assert.rejects(f.answer({ x: 0, y: 0 }, 200, { role: "audience", voterId: null }), e => e.code === "forbidden");
  await assert.rejects(f.answer({ x: 0, y: 0 }, 200, { role: "audience", voterId: "unknown" }), e => e.code === "not-joined");
  await assert.rejects(f.answer({ x: 0, y: 0 }, 200, undefined, { gameId: "other" }), e => e.code === "stale-round");
  const ids = { gameId: f.runtime.session.snapshot.id, roundId: syntaxRoundId(f.runtime.session.snapshot.id, 0) };
  for (const point of [null, [], {}, { x: -0.1, y: 0 }, { x: 1.1, y: 0 }, { x: 0, y: Infinity }, { x: "0", y: 0 }]) {
    assert.throws(() => parseSyntaxCommand({ type: "syntax:answer", ...ids, point }));
  }
  const command = parseSyntaxCommand({ type: "syntax:answer", ...ids, point: { x: 0, y: 0, correct: true }, receivedAt: 100, points: 1000000, correct: true, voterId: "other", role: "host" });
  assert.deepEqual(Object.keys(command).sort(), ["gameId", "point", "roundId", "type"]);
  await f.runtime.answer(command, { role: "audience", voterId: "voter" }, 300);
  assert.equal(f.runtime.session.answers[0].correct, false);
  assert.equal(f.runtime.session.answers[0].points, 0);
  assert.equal(f.runtime.session.answers[0].receivedAt, 300);
  assert.equal(f.runtime.session.answers[0].playerId, "voter");
  assert.throws(() => parseSyntaxCommand({ type: "syntax:close", ...ids }), /Early close/);
  await assert.rejects(f.command("reveal"), /timer/);
});

test("answer receipt/index/session/history commit atomically and retries recover failed persistence", async () => {
  const f = fixture(); await f.launch(); await f.command("open");
  const exec = f.storage.sql.exec;
  // Fail AFTER the receipt index and active session SQL writes, proving the
  // whole synchronous transaction rolls back rather than leaving a locked row.
  f.storage.sql.exec = (query, ...args) => {
    if (query.startsWith("INSERT INTO syntax_history")) throw new Error("SQL failure");
    return exec(query, ...args);
  };
  await assert.rejects(f.answer({ x: 0.25, y: 0.5 }, 200), /SQL failure/);
  assert.equal(f.runtime.session.answers.length, 0);
  assert.equal(f.storage.sql.exec("SELECT count(*) n FROM syntax_answers").toArray()[0].n, 0);
  assert.equal(JSON.parse(f.storage.sql.exec("SELECT data FROM syntax_runtime").toArray()[0].data).session.answers.length, 0);
  f.storage.sql.exec = exec;
  await f.answer({ x: 0.25, y: 0.5 }, 250);
  assert.equal(f.runtime.session.answers[0].receivedAt, 250);
  const history = JSON.parse(f.storage.sql.exec("SELECT data FROM syntax_history").toArray()[0].data);
  assert.deepEqual(history.answers, f.runtime.session.answers);
});

test("both submission modes lock one final point using immutable duration overrides", async () => {
  for (const submissionMode of ["first-click", "confirm"]) {
    const f = fixture(backing(), async (_, options) => {
      const s = snapshot(options.id, options.askPlayMode, options.submissionMode);
      return { ...s, rounds: s.rounds.map((r, i) => ({ ...r, durationMs: i ? 4000 : 2000 })) };
    });
    await f.runtime.command({ type: "syntax:launch", setId: "set", submissionMode }, "host", false, [player]);
    await f.command("open");
    assert.equal(f.runtime.session.snapshot.submissionMode, submissionMode);
    assert.equal(f.runtime.session.players[0].playMode, null);
    assert.equal(f.runtime.session.timing.deadlineAt, 2100);
    await f.answer({ x: 0.25, y: 0.5 }, 1100);
    assert.equal(f.runtime.session.answers[0].points, 500);
    assert.equal(f.runtime.session.answers[0].elapsedMs, 1000);
    await assert.rejects(f.answer({ x: 0, y: 0 }, 1200), e => e.code === "already-submitted");
    assert.throws(() => parseSyntaxCommand({ type: "syntax:draft", gameId: f.runtime.session.snapshot.id, roundId: syntaxRoundId(f.runtime.session.snapshot.id, 0), point: { x: 0.25, y: 0.5 } }), /Unsupported/);
    f.setNow(2100); await f.command("reveal"); await f.command("next"); await f.command("open");
    assert.equal(f.runtime.session.timing.deadlineAt, 6100);
  }
});

test("bounded shared reveal: fastest correct only, shared ties/groups, own ranks and anonymous ALL clicks via pages", async () => {
  const f = fixture(); await f.launch(); await f.command("open");
  let s = f.runtime.session;
  const players = Array.from({ length: 300 }, (_, i) => ({ id: `p${String(i).padStart(3, "0")}`, name: `Name ${i}`, playMode: i % 2 ? "online" : "in-person" }));
  const answers = players.map((p, i) => ({ playerId: p.id, roundIndex: 0, point: { x: i / 300, y: 0.5 }, receivedAt: 100 + Math.floor(i / 2), elapsedMs: Math.floor(i / 2), correct: i !== 0, points: i === 0 ? 0 : 1000 - Math.floor(i / 2) }));
  s = { ...s, players, answers };
  const hidden = buildSyntaxSharedProjection(s);
  const hiddenView = projectSyntaxSession(s, "p299", hidden);
  assert.deepEqual(hiddenView.standings, []); assert.deepEqual(hiddenView.roundStandings, []);
  assert.equal(hiddenView.yourStanding, null); assert.equal(hiddenView.yourRoundStanding, null); assert.equal(hiddenView.clicks, null);
  assert.throws(() => projectSyntaxClickPage(s, hidden, 0), e => e.code === "not-revealed");
  s = { ...s, phase: "revealed", revealedRoundIndexes: [0] };
  const shared = buildSyntaxSharedProjection(s);
  const view = projectSyntaxSession(s, "p299", shared);
  assert.equal(view.standings[0].standings.length, SYNTAX_STANDINGS_LIMIT);
  assert.equal(view.roundStandings[0].standings.length, SYNTAX_STANDINGS_LIMIT);
  assert.ok(!view.roundStandings.flatMap(g => g.standings).some(p => p.playerId === "p000"));
  assert.equal(view.yourStanding.rank, 150); assert.equal(view.yourRoundStanding.rank, 150);
  assert.equal(view.yourRoundStanding.elapsedMs, 149);
  const dots = [...view.clicks.points];
  assert.equal(dots.length, SYNTAX_CLICK_PAGE_SIZE);
  const second = projectSyntaxClickPage(s, shared, view.clicks.nextOffset);
  dots.push(...second.points);
  assert.equal(dots.length, 300); assert.equal(second.nextOffset, null);
  assert.ok(dots.every(p => Object.keys(p).sort().join(",") === "x,y"));
  // Across one combined competition, p002/p003 share rank 2 (p001 fastest).
  const combined = buildSyntaxSharedProjection({ ...s, snapshot: { ...s.snapshot, askPlayMode: false } });
  assert.deepEqual(combined.base.roundStandings[0].standings.slice(0, 3).map(r => [r.playerId, r.rank]), [["p001", 1], ["p002", 2], ["p003", 2]]);
  assert.deepEqual(combined.base.standings[0].standings.slice(0, 3).map(r => r.rank), [1, 2, 2]);
  // Shared public lists are reused, not recalculated per connection.
  assert.equal(projectSyntaxSession(s, "p001", shared).standings, view.standings);
  assert.equal(projectSyntaxSession(s, "p002", shared).roundStandings, view.roundStandings);
});

test("presentation history is constant-sized while prior scores remain cumulative and durable", async () => {
  let s = prepareSyntaxSession("long", { id: "longset", title: "Long", defaultDurationMs: 1000, submissionMode: "confirm", rounds: Array.from({ length: 30 }, () => ({ entryId: "entry" })) }, [{ id: "entry", title: "Code", image: { url: "/immutable/revision", width: 400, height: 200, alt: "Code" }, targets: [{ x: 0.5, y: 0.5, radius: 0.1 }], explanation: "revealed" }], 100, false);
  s = { ...s, phase: "revealed", roundIndex: 29, timing: { openedAt: 30000, deadlineAt: 31000 }, revealedRoundIndexes: Array.from({ length: 30 }, (_, i) => i), players: [player, { id: "late", name: "Late", playMode: null }], answers: Array.from({ length: 30 }, (_, i) => ({ playerId: "voter", roundIndex: i, point: { x: 0.5, y: 0.5 }, receivedAt: i * 1000 + 100, elapsedMs: 0, correct: true, points: 1000 })) };
  const view = projectSyntaxSession(s, "late");
  assert.equal(view.history.length, 1); assert.equal(view.revealedRounds, 30);
  assert.equal(view.standings[0].standings[0].points, 30000);
  assert.equal(view.yourStanding.points, 0); assert.equal(view.yourStanding.rank, 2);
  assert.deepEqual(view.reveal.yourResult, { correct: false, points: 0 });
  const storage = backing(); new SyntaxRuntimeStore(storage).save({ mode: "syntax", generation: 1, session: s });
  assert.equal(new SyntaxRuntimeStore(storage).load().session.revealedRoundIndexes.length, 30);
});

test("actual PollRoom integration: negotiated broadcast, host state auth, inactive poll commands, close wake hydration", async () => {
  const mock = `export class Server {
    constructor(ctx, env) { this.ctx=ctx;this.env=env;this.name='room';this.connections=[]; }
    getConnections() { return this.connections.values(); }
    sql(strings,...args) { return this.ctx.storage.sql.exec(strings.join('?'),...args).toArray(); }
  }`;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "partyserver") return { url: `data:text/javascript,${encodeURIComponent(mock)}`, shortCircuit: true };
    if (specifier === "./poll-images") return { url: `data:text/javascript,${encodeURIComponent("export const loadOptionImages=async()=>({});export const listRoomImages=async()=>({});export const deleteUnusedRoomImages=async()=>{};")}`, shortCircuit: true };
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(new URL(`${specifier}.ts`, context.parentURL).href, context);
    return next(specifier, context);
  } });
  const realNow = Date.now;
  let now = 100;
  Date.now = () => now;
  try {
    const { PollRoom } = await import("../src/poll-room.ts");
    const storage = backing();
    const env = { AdminRegistry: { idFromName: name => { assert.equal(name, "global"); return name; }, get: () => ({ fetch: async req => {
      assert.match(req.url, /\/syntax\/sets\/set\/snapshot$/);
      const options = await req.json();
      return Response.json(snapshot(options.id, options.askPlayMode, options.submissionMode));
    } }) } };
    let room = new PollRoom({ storage }, env);
    await room.onStart();
    const socket = (id, role, negotiated) => ({ id, state: { role, voterId: role === "audience" ? id : null, displayName: id, ...(negotiated ? { syntaxProtocol: 1 } : {}) }, sent: [], send(value) { this.sent.push(JSON.parse(value)); }, setState(state) { this.state=state; } });
    const host = socket("host", "host", true), legacy = socket("legacy", "audience", false), audience = socket("audience", "audience", true);
    room.connections = [host, legacy, audience];
    const send = (conn, value) => room.onMessage(conn, JSON.stringify(value));
    await send(audience, { type: "syntax:launch", setId: "set", submissionMode: "confirm", role: "host" });
    assert.match(audience.sent.at(-1).message, /host/);
    await send(host, { type: "syntax:launch", setId: "set", submissionMode: "confirm" });
    const state = host.sent.findLast(m => m.type === "syntax:state");
    assert.equal(state.mode, "syntax");
    assert.ok(legacy.sent.every(m => m.type === "state" || m.type === "error"));
    await send(host, { type: "reset-session" });
    assert.match(host.sent.at(-1).message, /inactive/);
    assert.equal((await room.onRequest(new Request("http://internal/reset", { method: "POST" }))).status, 409);
    assert.equal((await room.onRequest(new Request("http://internal/questions", { method: "PUT", body: "{}" }))).status, 409);
    await send(host, { type: "syntax:open", gameId: state.session.id, roundId: state.roundId });
    const ids = { gameId: state.session.id, roundId: state.roundId };
    await send(host, { type: "syntax:answer", ...ids, point: { x: 0.25, y: 0.5 }, role: "audience", voterId: "audience" });
    assert.equal(host.sent.at(-1).code, "forbidden");
    await send(audience, { type: "syntax:clicks", ...ids, offset: 0 });
    assert.equal(audience.sent.at(-1).code, "not-revealed");
    await send(host, { type: "syntax:close", ...ids });
    assert.equal(host.sent.at(-1).code, "invalid-payload");
    await send(host, { type: "syntax:reveal", ...ids });
    assert.equal(host.sent.at(-1).code, "command-rejected");
    await send(audience, { type: "syntax:answer", ...ids, point: { x: -1, y: 0 } });
    assert.equal(audience.sent.at(-1).code, "invalid-payload");

    const ensure = room.ensureStateLoaded.bind(room);
    room.ensureStateLoaded = async () => { throw new Error("temporary hydration failure"); };
    await send(audience, { type: "syntax:answer", ...ids, point: { x: 0.25, y: 0.5 } });
    assert.equal(audience.sent.at(-1).code, "internal-error");
    assert.ok(!audience.sent.at(-1).message.includes("hydration"));

    // Block initial hydration AFTER receipt. An alarm can close the round, but
    // a later Reveal message must not overtake this on-time answer in the queue.
    let unblock;
    const gate = new Promise(resolve => unblock = resolve);
    room.ensureStateLoaded = async () => { await gate; await ensure(); };
    const errorCount = host.sent.filter(m => m.type === "syntax:error").length;
    now = 150;
    const pendingEarlyReveal = send(host, { type: "syntax:reveal", ...ids });
    await Promise.resolve();
    now = 200;
    const answer = { type: "syntax:answer", ...ids, point: { x: 0.25, y: 0.5 }, receivedAt: -999, elapsedMs: 0, points: 999999, correct: true, voterId: "someone-else", role: "host" };
    const pendingAnswer = send(audience, answer);
    await Promise.resolve();
    now = 1100;
    const pendingReveal = send(host, { type: "syntax:reveal", ...ids });
    await room.syntax.reconcile();
    unblock();
    await Promise.all([pendingEarlyReveal, pendingAnswer, pendingReveal]);
    assert.equal(host.sent.filter(m => m.type === "syntax:error").length, errorCount + 1);
    assert.match(host.sent.findLast(m => m.type === "syntax:error").message, /timer/);
    const ack = audience.sent.findLast(m => m.type === "syntax:answer-ack");
    assert.equal(ack.status, "accepted"); assert.equal(ack.receipt.receivedAt, 200); assert.equal(ack.receipt.elapsedMs, 100);
    assert.ok(!JSON.stringify(ack).includes("correct")); assert.ok(!JSON.stringify(ack).includes("points"));
    const answerRecord = JSON.parse(storage.sql.exec("SELECT data FROM syntax_answers").toArray()[0].data);
    assert.equal(answerRecord.player.id, "audience"); assert.equal(answerRecord.answer.points, 900);
    assert.ok(audience.sent.filter(m => m.type === "syntax:state" && m.session && !["revealed", "finished"].includes(m.session.phase)).every(m => !/"(?:correct|points|rank|targets)"/.test(JSON.stringify(m))));
    const revealed = audience.sent.findLast(m => m.type === "syntax:state");
    assert.equal(revealed.session.phase, "revealed"); assert.equal(revealed.session.yourStanding.rank, 1);
    assert.equal(revealed.session.yourRoundStanding.elapsedMs, 100);
    assert.deepEqual(revealed.session.clicks.points, [{ x: 0.25, y: 0.5 }]);
    const cached = room.syntaxProjection;
    await send(audience, { type: "syntax:ready", ...ids, status: "ready" });
    assert.equal(room.syntaxProjection, cached); // Readiness broadcast reuses shared rankings.
    await send(audience, { type: "syntax:clicks", ...ids, offset: 0 });
    assert.deepEqual(audience.sent.at(-1).page.points, [{ x: 0.25, y: 0.5 }]);
    const tab = socket("other-tab", "audience", true); tab.state.voterId = "audience";
    room.connections.push(tab);
    await room.onConnect(tab, { request: new Request("http://worker/parties/poll-room/room?syntaxProtocol=1&voterId=audience&name=Changed&playMode=online") });
    assert.equal(room.syntax.session.players.find(p => p.id === "audience").name, "audience");
    assert.deepEqual(tab.sent.findLast(m => m.type === "syntax:state").yourReceipt, ack.receipt);
    await send(tab, answer);
    assert.equal(tab.sent.at(-1).status, "replayed"); assert.deepEqual(tab.sent.at(-1).receipt, ack.receipt);
    await send(tab, { ...answer, point: { x: 0, y: 0 } });
    assert.equal(tab.sent.at(-1).code, "already-submitted");
    await send(host, { type: "syntax:next", ...ids });
    const next = host.sent.findLast(m => m.type === "syntax:state");
    now = 1200;
    await send(host, { type: "syntax:open", gameId: next.session.id, roundId: next.roundId });
    await send(audience, answer);
    assert.equal(audience.sent.at(-1).code, "stale-round");
    // Simulate an expired persisted deadline and a hibernated close event.
    const record = JSON.parse(storage.sql.exec("SELECT data FROM syntax_runtime").toArray()[0].data);
    record.session.timing = { openedAt: 100, deadlineAt: 1100 };
    storage.sql.exec("UPDATE syntax_runtime SET data=?", JSON.stringify(record));
    room = new PollRoom({ storage }, env);
    room.connections = [host, legacy, audience];
    await room.onClose(audience, 1000, "", true);
    const woke = host.sent.findLast(m => m.type === "syntax:state");
    assert.equal(woke.session.phase, "closed");
    assert.equal(host.sent.findLast(m => m.type === "state").totalQuestions > 0, true);
    assert.equal(audience.sent.findLast(m => m.type === "syntax:state").session.reveal, null);
    assert.equal(audience.sent.findLast(m => m.type === "syntax:state").yourReceipt, null);
    assert.equal(audience.sent.findLast(m => m.type === "syntax:state").session.history.length, 1);
    assert.ok(legacy.sent.every(m => m.type === "state" || m.type === "error"));
  } finally { Date.now = realNow; hooks.deregister(); }
});
