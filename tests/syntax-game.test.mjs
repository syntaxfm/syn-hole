import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSyntaxLibrary, parseSyntaxLibraryEntry, parseSyntaxPoint, parseSyntaxSavedSet, SYNTAX_DEFAULT_DURATION_MS } from "~/syntax-game/validation";
import { syntaxClientPoint, syntaxContainTransform, syntaxIsHit, syntaxTargetContains } from "~/syntax-game/geometry";
import { groupSyntaxStandings, rankSyntaxPlayers, scoreSyntaxAnswer } from "~/syntax-game/scoring";
import { abortSyntaxSession, advanceSyntaxSession, closeExpiredSyntaxRound, joinSyntaxSession, prepareSyntaxSession, revealSyntaxRound, startSyntaxRound } from "~/syntax-game/session";
import { projectSyntaxSession } from "~/syntax-game/projections";

const entry = () => ({
  id: "entry-1", title: "Find the error",
  image: { url: "/syntax/immutable-image.png", width: 1000, height: 500, alt: "Code sample" },
  targets: [{ x: 0.5, y: 0.5, radius: 0.125 }], explanation: "Hidden explanation",
});
const set = () => ({ id: "set-1", title: "Game", rounds: [{ entryId: "entry-1" }] });
const player = (id = "voter", playMode = null) => ({ id, name: id, playMode });
const prepared = (rawSet = set(), askPlayMode = false) => prepareSyntaxSession("session", rawSet, [entry()], 1000, askPlayMode);
const open = (rawSet = set()) => startSyntaxRound(joinSyntaxSession(prepared(rawSet), player()), 2000);

// Projection fixtures only. Actual answer acceptance/replay/persistence is tested
// through SyntaxRuntime in syntax-runtime.test.mjs, not a second implementation.
function answered(session, point, receivedAt) {
  const { entry } = session.snapshot.rounds[session.roundIndex];
  const correct = syntaxIsHit(point, entry.targets, entry.image);
  return { ...session, answers: [...session.answers, {
    playerId: "voter", roundIndex: session.roundIndex, point, receivedAt,
    elapsedMs: receivedAt - session.timing.openedAt, correct,
    points: scoreSyntaxAnswer(correct, receivedAt, session.timing),
  }] };
}

test("unknown parsers copy allowlisted fields, defaults, ordered repeats and overrides", () => {
  const parsed = parseSyntaxLibraryEntry({ ...entry(), secret: true });
  assert.equal("secret" in parsed, false);
  assert.notEqual(parsed.image, entry().image);
  const saved = parseSyntaxSavedSet({ ...set(), rounds: [{ entryId: "entry-1", durationMs: 2000 }, { entryId: "entry-1" }] });
  assert.equal(saved.defaultDurationMs, SYNTAX_DEFAULT_DURATION_MS);
  assert.equal(saved.submissionMode, "first-click");
  assert.equal(saved.rounds.length, 2);
  assert.equal(saved.rounds[0].durationMs, 2000);
  assert.deepEqual(parseSyntaxPoint({ x: 0, y: 1, points: 1000, receivedAt: 1 }), { x: 0, y: 1 });
  assert.deepEqual(parseSyntaxLibrary([]), []);
});

test("malformed input rejected with readable field errors", () => {
  for (const raw of [null, [], "point", { x: NaN, y: 0 }, { x: Infinity, y: 0 }, { x: -0.01, y: 0 }, { x: 1, y: 1.01 }]) {
    assert.throws(() => parseSyntaxPoint(raw), /Point/);
  }
  for (const patch of [{ id: "../x" }, { title: " " }, { targets: [] }, { targets: [{ x: 0, y: 0, radius: 0 }] }, { targets: [{ x: 0, y: 0, radius: Infinity }] }]) {
    assert.throws(() => parseSyntaxLibraryEntry({ ...entry(), ...patch }), /entry|Entry/);
  }
  for (const patch of [{ width: 0 }, { height: 1.2 }, { width: Infinity }, { url: "javascript:alert(1)" }, { url: "//evil.test/image" }, { url: "https://user:pass@example.com/x" }]) {
    assert.throws(() => parseSyntaxLibraryEntry({ ...entry(), image: { ...entry().image, ...patch } }), /image/);
  }
  for (const duration of [null, NaN, Infinity, 0, 999, 300001, 1000.5, "30000"]) {
    assert.throws(() => parseSyntaxSavedSet({ ...set(), defaultDurationMs: duration }), /Duration/);
  }
  assert.throws(() => parseSyntaxSavedSet({ ...set(), submissionMode: "draft" }), /submissionMode/);
  assert.throws(() => parseSyntaxSavedSet({ ...set(), submissionMode: null }), /submissionMode/);
  assert.throws(() => parseSyntaxLibraryEntry({ ...entry(), explanation: null }), /explanation/);
  assert.throws(() => parseSyntaxSavedSet({ ...set(), rounds: [] }), /rounds/);
  assert.throws(() => parseSyntaxLibrary([entry(), entry()]), /Duplicate/);
  assert.throws(() => prepareSyntaxSession("session", { ...set(), rounds: [{ entryId: "missing" }] }, [entry()], 0, false), /missing/);
});

test("original-image circles remain aspect-correct, include boundary, accept any target", () => {
  const target = { x: 0.5, y: 0.5, radius: 0.125 };
  const wide = { width: 1000, height: 500 };
  const tall = { width: 500, height: 1000 };
  const square = { width: 500, height: 500 };
  assert.equal(syntaxTargetContains({ x: 0.625, y: 0.5 }, target, wide), true);
  assert.equal(syntaxTargetContains({ x: 0.5, y: 0.75 }, target, wide), true);
  assert.equal(syntaxTargetContains({ x: 0.5, y: 0.75 }, target, tall), false);
  assert.equal(syntaxTargetContains({ x: 0.5, y: 0.5625 }, target, tall), true);
  assert.equal(syntaxTargetContains({ x: 0.5, y: 0.625 }, target, square), true);
  assert.equal(syntaxTargetContains({ x: 0.625, y: 0.625 }, target, square), false);
  assert.equal(syntaxTargetContains({ x: 0.8, y: 0.5 }, { ...target, radius: 0.3 }, square), true);
  assert.equal(syntaxIsHit({ x: 0, y: 0 }, [target, { x: 0, y: 0, radius: 0.01 }], tall), true);
  assert.throws(() => syntaxIsHit({ x: 2, y: 0 }, [target], wide), /Point.x/);
});

test("client conversion rejects letterboxing/outside/invalid input and supports affine transforms and clipping", () => {
  const transform = syntaxContainTransform({ width: 1000, height: 500 }, { left: 10, top: 20, width: 200, height: 200 });
  assert.deepEqual(transform, { a: 200, b: 0, c: 0, d: 100, e: 10, f: 70 });
  assert.deepEqual(syntaxClientPoint({ x: 110, y: 120 }, transform), { x: 0.5, y: 0.5 });
  assert.deepEqual(syntaxClientPoint({ x: 10, y: 70 }, transform), { x: 0, y: 0 });
  assert.equal(syntaxClientPoint({ x: 110, y: 40 }, transform), null);
  assert.equal(syntaxClientPoint({ x: 211, y: 100 }, transform), null);
  assert.equal(syntaxClientPoint({ x: NaN, y: 100 }, transform), null);
  assert.equal(syntaxClientPoint({ x: 10, y: 70 }, { ...transform, a: 0 }), null);
  assert.equal(syntaxClientPoint({ x: 10, y: 70 }, { ...transform, a: Infinity }), null);
  // 90 degree rotation plus translation, representing a transformed content quad.
  assert.deepEqual(syntaxClientPoint({ x: 150, y: 100 }, { a: 0, b: 200, c: -100, d: 0, e: 200, f: 0 }), { x: 0.5, y: 0.5 });
  assert.equal(syntaxClientPoint({ x: 110, y: 120 }, transform, { left: 0, top: 0, width: 50, height: 50 }), null);
  assert.throws(() => syntaxContainTransform({ width: 0, height: 1 }, { left: 0, top: 0, width: 10, height: 10 }), /dimensions/);
});

test("proportional score rounds to nearest integer and deadline is excluded", () => {
  const timing = { openedAt: 1000, deadlineAt: 4000 };
  assert.equal(scoreSyntaxAnswer(true, 1000, timing), 1000);
  assert.equal(scoreSyntaxAnswer(true, 2000, timing), 667);
  assert.equal(scoreSyntaxAnswer(true, 2500, timing), 500);
  assert.equal(scoreSyntaxAnswer(true, 3999, timing), 0);
  assert.equal(scoreSyntaxAnswer(true, 4000, timing), 0);
  assert.equal(scoreSyntaxAnswer(true, 999, timing), 0);
  assert.equal(scoreSyntaxAnswer(false, 1000, timing), 0);
  assert.throws(() => scoreSyntaxAnswer(true, NaN, timing), /Timestamp/);
  assert.throws(() => scoreSyntaxAnswer(true, 1000, { openedAt: 1000, deadlineAt: 1000 }), /Deadline/);
});

test("snapshot is copied/frozen, duration overrides resolve, mode preserved", () => {
  const library = [entry()];
  const saved = { ...set(), submissionMode: "confirm", defaultDurationMs: 4000, rounds: [{ entryId: "entry-1", durationMs: 2000 }, { entryId: "entry-1" }] };
  const session = prepareSyntaxSession("session", saved, library, 1000, false);
  library[0].targets[0].x = 0;
  saved.rounds[0].durationMs = 9000;
  assert.equal(session.snapshot.rounds[0].entry.targets[0].x, 0.5);
  assert.deepEqual(session.snapshot.rounds.map((round) => round.durationMs), [2000, 4000]);
  assert.equal(session.snapshot.submissionMode, "confirm");
  assert.throws(() => { session.snapshot.rounds[0].entry.targets[0].x = 0; }, TypeError);
  assert.equal(startSyntaxRound(session, 2000).timing.deadlineAt, 4000);
});

test("deadline closes without reveal/advance; final reveal permits finish", () => {
  const session = open();
  assert.equal(closeExpiredSyntaxRound(session, 31999), session);
  const closed = closeExpiredSyntaxRound(session, 32000);
  assert.equal(closed.phase, "closed");
  assert.equal(closed.roundIndex, 0);
  assert.equal(closed.revealedRoundIndexes.length, 0);
  assert.throws(() => advanceSyntaxSession(closed), /Reveal/);
  assert.throws(() => revealSyntaxRound(session), /closed/);
  const finished = advanceSyntaxSession(revealSyntaxRound(closed));
  assert.equal(finished.phase, "finished");
  assert.throws(() => startSyntaxRound(finished, 40000), /prepared/);
});

test("manual next prepares; reconnect/late join retain history; abort never reveals", () => {
  let session = open({ ...set(), rounds: [{ entryId: "entry-1" }, { entryId: "entry-1" }] });
  session = revealSyntaxRound(closeExpiredSyntaxRound(session, 32000));
  session = advanceSyntaxSession(session);
  assert.equal(session.phase, "prepared");
  assert.equal(session.roundIndex, 1);
  assert.equal(session.timing, null);
  session = joinSyntaxSession(session, player("late"));
  assert.equal(joinSyntaxSession(session, { ...player(), name: "changed" }), session);
  session = abortSyntaxSession(startSyntaxRound(session, 33000));
  assert.equal(session.phase, "aborted");
  assert.deepEqual(session.revealedRoundIndexes, [0]);
  assert.equal(projectSyntaxSession(session, "late").history.length, 1);
  assert.equal(projectSyntaxSession(session).reveal, null);
});

test("aggregate ties share competition ranks, stable id order; groups respect room setting", () => {
  const players = [player("c", "online"), player("b", "in-person"), player("a", "online"), player("d")];
  const answers = [
    { playerId: "b", roundIndex: 0, correct: true, points: 500 },
    { playerId: "a", roundIndex: 0, correct: true, points: 250 },
    { playerId: "a", roundIndex: 1, correct: true, points: 250 },
    { playerId: "c", roundIndex: 2, correct: true, points: 1000 },
  ];
  const rows = rankSyntaxPlayers(players, answers, [0, 1]);
  assert.deepEqual(rows.map((row) => [row.playerId, row.points, row.rank]), [["a", 500, 1], ["b", 500, 1], ["c", 0, 3], ["d", 0, 3]]);
  assert.equal(rows[0].correct, 2); // Correct count is not a hidden tie-breaker.
  const grouped = groupSyntaxStandings(players, answers, [0, 1], true);
  assert.deepEqual(grouped.map((group) => group.playMode), ["in-person", "online", null]);
  assert.equal(grouped[1].standings[0].playerId, "a");
  const combined = groupSyntaxStandings(players, answers, [0], false);
  assert.equal(combined.length, 1);
  assert.ok(combined[0].standings.every((row) => row.playMode === null));
});

test("safe projections hide targets/explanations/results and unrevealed score changes", () => {
  const initial = open();
  const hit = answered(initial, { x: 0.5, y: 0.5 }, 2000);
  const miss = answered(initial, { x: 0, y: 0 }, 2000);
  // Projector sees indistinguishable correct and incorrect submissions.
  assert.deepEqual(projectSyntaxSession(hit), projectSyntaxSession(miss));
  for (const session of [initial, hit, closeExpiredSyntaxRound(hit, 32000), abortSyntaxSession(hit)]) {
    const view = projectSyntaxSession(session, "voter");
    const json = JSON.stringify(view);
    assert.equal(json.includes("targets"), false);
    assert.equal(json.includes("explanation"), false);
    assert.equal(json.includes("receivedAt"), false);
    assert.equal(view.reveal, null);
    assert.equal(view.history.length, 0);
    assert.deepEqual(view.standings, []); // No ranks/scores before the first reveal.
    assert.equal(view.yourStanding, null);
  }
  assert.deepEqual(projectSyntaxSession(hit, "voter").yourSubmission, { x: 0.5, y: 0.5 });
  assert.equal(projectSyntaxSession(hit, "other").yourSubmission, null);
  const revealed = revealSyntaxRound(closeExpiredSyntaxRound(hit, 32000));
  const view = projectSyntaxSession(revealed, "voter");
  assert.equal(view.reveal.explanation, "Hidden explanation");
  assert.deepEqual(view.reveal.yourResult, { correct: true, points: 1000 });
  assert.equal(view.standings[0].standings[0].points, 1000);
  view.reveal.targets[0].x = 0;
  assert.equal(revealed.snapshot.rounds[0].entry.targets[0].x, 0.5);
});

test("new hidden round cannot leak via totals/history, even after prior reveal", () => {
  let session = open({ ...set(), rounds: [{ entryId: "entry-1" }, { entryId: "entry-1" }] });
  session = answered(session, { x: 0.5, y: 0.5 }, 2000);
  session = startSyntaxRound(advanceSyntaxSession(revealSyntaxRound(closeExpiredSyntaxRound(session, 32000))), 33000);
  const before = projectSyntaxSession(session);
  const after = projectSyntaxSession(answered(session, { x: 0.5, y: 0.5 }, 33000));
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(after.standings, before.standings);
  assert.equal(after.reveal, null);
});
