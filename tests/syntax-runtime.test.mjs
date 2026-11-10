import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { SyntaxRuntime } from "../src/syntax-game/runtime.ts";
import { parseSyntaxCommand, syntaxRoundId } from "../src/syntax-game/protocol.ts";
import { prepareSyntaxSession, serializeSyntaxSnapshot } from "../src/syntax-game/session.ts";
import { SYNTAX_MAX_PLAYERS, SYNTAX_MAX_SNAPSHOT_BYTES } from "../src/syntax-game/validation.ts";
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
  assert.equal(new SyntaxRuntimeStore(f.storage).load().session.phase, "open");
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
  assert.equal(new SyntaxRuntimeStore(f.storage).load().session.answers.length, 0);
  f.storage.sql.exec = exec;
  await f.answer({ x: 0.25, y: 0.5 }, 250);
  assert.equal(f.runtime.session.answers[0].receivedAt, 250);
  const history = new SyntaxRuntimeStore(f.storage).history(f.runtime.session.snapshot.id);
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

test("conference-scale history uses bounded SQL rows and constant-size answer writes", async () => {
  const storage = backing();
  const exec = storage.sql.exec;
  let writtenBytes = 0;
  storage.sql.exec = (query, ...args) => {
    for (const arg of args) if (typeof arg === "string") {
      const bytes = Buffer.byteLength(arg);
      assert.ok(bytes < 2 * 1024 * 1024, "Cloudflare SQL value limit");
      if (/^(INSERT|UPDATE)/.test(query)) writtenBytes += bytes;
    }
    return exec(query, ...args);
  };
  const players = Array.from({ length: SYNTAX_MAX_PLAYERS }, (_, i) => ({ id: `p${i}`, name: "Conference participant", playMode: null }));
  const openedAt = 1_794_220_000_000;
  const answers = Array.from({ length: 13 }, (_, roundIndex) => players.map(p => ({ playerId: p.id, roundIndex, point: { x: .1234567890123456, y: .2345678901234567 }, receivedAt: openedAt + 100, elapsedMs: 100, correct: false, points: 0 }))).flat().slice(0, -1);
  const saved = { snapshot: snapshot("scale", false, "confirm", 13), phase: "open", roundIndex: 12, timing: { openedAt, deadlineAt: openedAt + 1000 }, revealedRoundIndexes: Array.from({ length: 12 }, (_, i) => i), players, answers };
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) > 2 * 1024 * 1024);
  const store = new SyntaxRuntimeStore(storage);
  store.save({ mode: "syntax", generation: 1, session: saved });
  assert.deepEqual(store.load().session, saved);
  const f = fixture(storage);
  f.setNow(openedAt);
  writtenBytes = 0;
  assert.equal(await f.runtime.join({ id: "overflow", name: "Extra identity", playMode: null }), false);
  assert.equal(await f.runtime.join({ ...players[0], name: "Changed name" }), true);
  assert.equal(f.runtime.session.players[0].name, players[0].name);
  const last = players.at(-1);
  const ack = await f.answer({ x: .25, y: .5 }, openedAt + 100, { role: "audience", voterId: last.id });
  assert.equal(ack.status, "accepted");
  assert.ok(writtenBytes < 16000, `Only small metadata/receipt writes, got ${writtenBytes}`);
  const loaded = new SyntaxRuntimeStore(storage).load().session;
  assert.deepEqual(loaded, f.runtime.session);
  assert.equal(loaded.answers.length, SYNTAX_MAX_PLAYERS * 13);
  assert.equal(store.listHistory({ limit: 20, offset: 0 }).games[0].participants, SYNTAX_MAX_PLAYERS);
  for (const table of ["syntax_runtime", "syntax_history", "syntax_runtime_snapshots", "syntax_players", "syntax_answers"]) {
    assert.ok(storage.sql.exec(`SELECT max(length(CAST(data AS BLOB))) n FROM ${table}`).toArray()[0].n <= SYNTAX_MAX_SNAPSHOT_BYTES);
  }
});

test("launch admission is bounded without blocking the game or reconnects", async () => {
  const f = fixture();
  const players = Array.from({ length: SYNTAX_MAX_PLAYERS + 1 }, (_, i) => ({ id: `p${i}`, name: "Player", playMode: null }));
  await f.runtime.command({ type: "syntax:launch", setId: "set", submissionMode: "confirm" }, "host", false, players);
  assert.equal(f.runtime.session.players.length, SYNTAX_MAX_PLAYERS);
  assert.equal(await f.runtime.join(players.at(-1)), false);
  assert.equal(await f.runtime.join(players[0]), true);
  await f.command("open");
  assert.equal((await f.answer({ x: .25, y: .5 }, 200, { role: "audience", voterId: "p0" })).status, "accepted");
});

test("oversized UTF-8 snapshots fail atomically before any game state is published", () => {
  const original = snapshot("large", false, "confirm", 100);
  const large = { ...original, rounds: original.rounds.map(round => ({ ...round, entry: { ...round.entry, title: "字".repeat(2000), explanation: "字".repeat(2000) } })) };
  assert.throws(() => serializeSyntaxSnapshot(large), /too large/);
  const storage = backing(), store = new SyntaxRuntimeStore(storage);
  assert.throws(() => store.save({ mode: "syntax", generation: 1, session: { snapshot: large, phase: "prepared", roundIndex: 0, timing: null, revealedRoundIndexes: [], players: [], answers: [] } }), /too large/);
  assert.equal(store.load().session, null);
  assert.equal(store.history("large"), null);
  assert.equal(storage.sql.exec("SELECT count(*) n FROM syntax_runtime_snapshots").toArray()[0].n, 0);
});

test("legacy full-session data migrates on write, atomically and without losing indexed or unindexed answers", async () => {
  const storage = backing(), store = new SyntaxRuntimeStore(storage);
  const saved = { snapshot: snapshot("legacy"), phase: "open", roundIndex: 1, timing: { openedAt: 100, deadlineAt: 1100 }, revealedRoundIndexes: [0], players: [player], answers: [0, 1].map(roundIndex => ({ playerId: player.id, roundIndex, point: { x: .25, y: .5 }, receivedAt: 200, elapsedMs: 100, correct: true, points: 900 })) };
  const legacy = { mode: "syntax", generation: 1, session: saved };
  storage.sql.exec("INSERT INTO syntax_runtime(id,data) VALUES(1,?)", JSON.stringify(legacy));
  storage.sql.exec("INSERT INTO syntax_history(id,data) VALUES(?,?)", "legacy", JSON.stringify(saved));
  storage.sql.exec("INSERT INTO syntax_answers(game_id,round_index,player_id,data) VALUES(?,?,?,?)", "legacy", 0, player.id, JSON.stringify({ player, answer: saved.answers[0] }));
  assert.deepEqual(store.load(), legacy);
  assert.deepEqual(store.history("legacy"), saved);
  const f = fixture(storage), exec = storage.sql.exec;
  storage.sql.exec = (query, ...args) => {
    if (query.startsWith("INSERT INTO syntax_history")) throw new Error("migration failure");
    return exec(query, ...args);
  };
  await assert.rejects(f.runtime.join({ id: "late", name: "Late", playMode: null }), /migration failure/);
  assert.deepEqual(store.load(), legacy);
  assert.equal(storage.sql.exec("SELECT count(*) n FROM syntax_runtime_snapshots").toArray()[0].n, 0);
  assert.equal(storage.sql.exec("SELECT count(*) n FROM syntax_players").toArray()[0].n, 0);
  storage.sql.exec = exec;
  await f.runtime.join({ id: "late", name: "Late", playMode: null });
  const migrated = store.load();
  assert.deepEqual(migrated.session.answers, saved.answers);
  assert.deepEqual(migrated.session.players, [player, { id: "late", name: "Late", playMode: null }]);
  assert.equal(JSON.parse(storage.sql.exec("SELECT data FROM syntax_runtime").toArray()[0].data).storageVersion, 2);
  assert.equal(storage.sql.exec("SELECT count(*) n FROM syntax_answers").toArray()[0].n, 2);
  assert.deepEqual(store.history("legacy"), migrated.session);
});

test("previously valid snapshots over the new launch budget can migrate, abort and return to polls", async () => {
  const storage = backing(), store = new SyntaxRuntimeStore(storage);
  const entries = Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, title: "漢".repeat(2000), image: { url: "/immutable/revision", width: 400, height: 200, alt: "漢".repeat(2000) }, targets: [{ x: .5, y: .5, radius: .1 }], explanation: "漢".repeat(1000) }));
  const saved = prepareSyntaxSession("legacy-large", { id: "set", title: "Existing set", defaultDurationMs: 1000, rounds: entries.map(entry => ({ entryId: entry.id })) }, entries, 100, false);
  const legacy = { mode: "syntax", generation: 1, session: saved };
  const bytes = Buffer.byteLength(JSON.stringify(legacy));
  assert.ok(bytes > SYNTAX_MAX_SNAPSHOT_BYTES && bytes < 2_000_000);
  assert.throws(() => serializeSyntaxSnapshot(saved.snapshot), /too large/); // New launches still fail.
  storage.sql.exec("INSERT INTO syntax_runtime(id,data) VALUES(1,?)", JSON.stringify(legacy));
  storage.sql.exec("INSERT INTO syntax_history(id,data) VALUES(?,?)", saved.snapshot.id, JSON.stringify(saved));
  const f = fixture(storage);
  await f.command("open");
  assert.equal(f.runtime.session.phase, "open");
  assert.deepEqual(store.history(saved.snapshot.id).snapshot, saved.snapshot);
  await f.command("abort");
  await f.command("polls");
  const loaded = fixture(storage);
  assert.equal(loaded.runtime.mode, "poll");
  assert.equal(loaded.runtime.session.phase, "aborted");
  assert.deepEqual(loaded.runtime.session.snapshot, saved.snapshot);
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
    for (const hostileId of [".", "x".repeat(200), "a/b"]) {
      const hostile = socket(hostileId, "audience", true);
      room.connections.push(hostile);
      await room.onConnect(hostile, { request: new Request(`http://worker/parties/poll-room/room?_pk=${encodeURIComponent(hostileId)}&voterId=invalid.id&syntaxProtocol=1`) });
      assert.equal(hostile.state.voterId, hostileId); // Legacy poll identity is untouched.
      assert.match(hostile.state.syntaxVoterId, /^[a-zA-Z0-9_-]{1,64}$/);
      assert.notEqual(hostile.state.syntaxVoterId, hostileId);
      assert.equal(room.syntaxPlayerId(hostile), hostile.state.syntaxVoterId);
    }
    // A pre-upgrade hibernated connection must not poison launch either.
    const oldInvalid = socket("old-invalid", "audience", true);
    oldInvalid.state.voterId = ".";
    room.connections.push(oldInvalid);
    const send = (conn, value) => room.onMessage(conn, JSON.stringify(value));
    await send(audience, { type: "syntax:launch", setId: "set", submissionMode: "confirm", role: "host" });
    assert.match(audience.sent.at(-1).message, /host/);
    await send(host, { type: "syntax:launch", setId: "set", submissionMode: "confirm" });
    assert.equal(oldInvalid.state.voterId, ".");
    assert.match(oldInvalid.state.syntaxVoterId, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(room.syntax.session.players.some(player => player.id === oldInvalid.state.syntaxVoterId));
    const state = host.sent.findLast(m => m.type === "syntax:state");
    assert.equal(state.mode, "syntax");
    assert.ok(legacy.sent.every(m => m.type === "state" || m.type === "error"));
    const ready = { type: "syntax:ready", gameId: state.session.id, roundId: state.roundId, status: "ready" };
    const beforeReady = [host.sent.length, legacy.sent.length, audience.sent.length];
    await Promise.all(Array.from({ length: 100 }, () => send(audience, ready)));
    assert.equal(host.sent.length - beforeReady[0], 1);
    assert.equal(legacy.sent.length, beforeReady[1]);
    assert.equal(audience.sent.length, beforeReady[2]);
    for (let i = 0; i < 100; i++) await send(audience, { ...ready, status: i % 2 ? "ready" : "failed" });
    assert.ok(host.sent.length - beforeReady[0] <= 2);
    assert.equal(audience.sent.length, beforeReady[2]);
    // Rate budget survives attachment rehydration, not just a JS WeakMap.
    const restored = { ...audience, state: structuredClone(audience.state) };
    for (let i = 0; i < 100; i++) await send(restored, { ...ready, status: i % 2 ? "ready" : "failed" });
    assert.ok(host.sent.length - beforeReady[0] <= 2);
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
    await send(oldInvalid, { type: "syntax:answer", gameId: next.session.id, roundId: next.roundId, point: { x: 0, y: 0 } });
    assert.equal(oldInvalid.sent.at(-1).status, "accepted");
    assert.ok(room.syntax.session.answers.some(answer => answer.playerId === oldInvalid.state.syntaxVoterId));
    assert.deepEqual(oldInvalid.sent.findLast(message => message.type === "syntax:state").yourReceipt.point, { x: 0, y: 0 });
    await send(audience, answer);
    assert.equal(audience.sent.at(-1).code, "stale-round");
    // Simulate an expired persisted deadline and a hibernated close event.
    const record = JSON.parse(storage.sql.exec("SELECT data FROM syntax_history WHERE id=?", next.session.id).toArray()[0].data);
    record.timing = { openedAt: 100, deadlineAt: 1100 };
    storage.sql.exec("UPDATE syntax_history SET data=? WHERE id=?", JSON.stringify(record), next.session.id);
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
