import test from "node:test";
import assert from "node:assert/strict";
import { SYNTAX_EMPTY_ANSWER, SyntaxClickAccumulator, syntaxAttemptAnswer, syntaxEstimatedNow, syntaxMatchesRound, syntaxReceiveAnswer, syntaxRemainingMs } from "../src/components/syntax-player-state.ts";

const point = { x: 0.2, y: 0.4 };
const receipt = { gameId: "g", roundId: "g:0", point, receivedAt: 2000, elapsedMs: 1000 };
const ack = { type: "syntax:answer-ack", status: "accepted", receipt };
const session = { phase: "open", timing: { openedAt: 1000, deadlineAt: 11000 } };

test("countdown uses original server deadline, not join/load/reconnect time", () => {
  assert.equal(syntaxRemainingMs(session, 6000), 5000);
  assert.equal(syntaxRemainingMs(session, 11000), 0);
  assert.equal(syntaxRemainingMs(session, 12000), 0);
  for (const phase of ["prepared", "closed", "revealed", "finished", "aborted"]) assert.equal(syntaxRemainingMs({ ...session, phase }, 6000), 0);
  assert.equal(syntaxRemainingMs({ ...session, timing: null }, 6000), 0);
});

test("clock offset tolerates backward wall drift and conservatively freezes on forward drift", () => {
  const anchor = { serverNow: 6000, wallNow: 100000, monotonicNow: 100 };
  assert.equal(syntaxEstimatedNow(anchor, 100500, 600), 6500);
  assert.equal(syntaxEstimatedNow(anchor, 90000, 1100), 7000);
  assert.equal(syntaxEstimatedNow(anchor, 110000, 1100), 16000);
  assert.equal(syntaxEstimatedNow(anchor, 90000, 0), 6000);
});

test("first attempt locks immediately; confirm drafts remain local until attempted", () => {
  const draft = { ...SYNTAX_EMPTY_ANSWER, draft: point };
  assert.equal(draft.attempted, null);
  const pending = syntaxAttemptAnswer(draft, point);
  assert.equal(pending.status, "pending");
  assert.equal(pending.attempted, point);
  assert.equal(syntaxAttemptAnswer(pending, { x: 1, y: 1 }), pending);
});

test("ambiguous disconnect and rejection cannot change the original retry point", () => {
  const pending = syntaxAttemptAnswer(SYNTAX_EMPTY_ANSWER, point);
  const uncertain = { ...pending, status: "uncertain" };
  assert.equal(syntaxAttemptAnswer(uncertain, { x: 0.9, y: 0.9 }), uncertain);
  const error = { type: "syntax:error", command: "syntax:answer", code: "internal-error", message: "Retry", gameId: "g", roundId: "g:0" };
  const rejected = syntaxReceiveAnswer(uncertain, error, "g", "g:0");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.attempted, point);
  assert.equal(syntaxAttemptAnswer(rejected, { x: 0.9, y: 0.9 }), rejected);
});

test("accepted/replayed receipt restores actual point even from another tab; accepted is not correctness", () => {
  for (const status of ["accepted", "replayed"]) {
    const restored = syntaxReceiveAnswer(SYNTAX_EMPTY_ANSWER, { ...ack, status }, "g", "g:0");
    assert.equal(restored.status, "accepted");
    assert.deepEqual(restored.receipt, receipt);
    assert.equal(restored.draft, null);
    assert.equal("correct" in restored, false);
    assert.equal(syntaxAttemptAnswer(restored, { x: 0, y: 0 }), restored);
  }
});

test("late messages from another game/round and uncorrelated errors are ignored", () => {
  const local = syntaxAttemptAnswer(SYNTAX_EMPTY_ANSWER, point);
  for (const ids of [{ gameId: "old", roundId: "g:0" }, { gameId: "g", roundId: "g:1" }]) {
    assert.equal(syntaxReceiveAnswer(local, { ...ack, receipt: { ...receipt, ...ids } }, "g", "g:0"), local);
    assert.equal(syntaxMatchesRound(ids, "g", "g:0"), false);
  }
  assert.equal(syntaxReceiveAnswer(local, { type: "syntax:error", command: "syntax:answer", message: "Bad input" }, "g", "g:0"), local);
  assert.equal(syntaxReceiveAnswer(local, { type: "syntax:error", command: "syntax:ready", gameId: "g", roundId: "g:0", message: "Bad input" }, "g", "g:0"), local);
});

test("a delayed rejection cannot erase an accepted receipt", () => {
  const accepted = syntaxReceiveAnswer(SYNTAX_EMPTY_ANSWER, ack, "g", "g:0");
  assert.equal(syntaxReceiveAnswer(accepted, { type: "syntax:error", command: "syntax:answer", gameId: "g", roundId: "g:0", message: "Old error" }, "g", "g:0"), accepted);
});

test("round-key reset uses round ID, including repeated image rounds", () => {
  const locked = syntaxReceiveAnswer(SYNTAX_EMPTY_ANSWER, ack, "g", "g:0");
  assert.notEqual(locked, SYNTAX_EMPTY_ANSWER);
  assert.equal(SYNTAX_EMPTY_ANSWER.draft, null);
  assert.equal(SYNTAX_EMPTY_ANSWER.attempted, null);
  assert.equal(syntaxReceiveAnswer(SYNTAX_EMPTY_ANSWER, ack, "g", "g:1"), SYNTAX_EMPTY_ANSWER);
});

const page = (points, nextOffset, total = 5, roundIndex = 0) => ({ roundIndex, points, nextOffset, total });
test("projector pages append every point including identical clicks, exactly once", () => {
  const clicks = new SyntaxClickAccumulator(page([point, point], 2));
  assert.equal(clicks.request(), 2);
  assert.equal(clicks.request(), null);
  assert.equal(clicks.accept(page([point, point], 4)), true);
  assert.equal(clicks.request(), 4);
  assert.equal(clicks.accept(page([point], null)), true);
  assert.equal(clicks.points.length, 5);
  assert.equal(clicks.nextOffset, null);
  assert.equal(clicks.request(), null);
});

test("stale/duplicate, wrong-round, mismatched-total and empty click pages cannot advance", () => {
  const clicks = new SyntaxClickAccumulator(page([point, point], 2));
  assert.equal(clicks.accept(page([point, point], 4)), false);
  assert.equal(clicks.request(), 2);
  for (const bad of [page([point, point], 2), page([point, point], 4, 5, 1), page([point, point], 4, 6), page([], 2)]) assert.equal(clicks.accept(bad), false);
  assert.equal(clicks.accept(page([point, point], 4)), true);
  assert.equal(clicks.request(), 4);
  assert.equal(clicks.accept(page([point, point], 4)), false);
  assert.equal(clicks.accept(page([point], null)), true);
});

test("missing response pauses pagination until explicit same-offset retry; no infinite effects", () => {
  const clicks = new SyntaxClickAccumulator(page([point, point], 2));
  assert.equal(clicks.request(), 2);
  for (let n = 0; n < 10; n++) assert.equal(clicks.request(), null);
  clicks.retry();
  assert.equal(clicks.request(), 2);
  assert.equal(clicks.request(), null);
});

test("empty and complete initial page need no follow-up requests", () => {
  assert.equal(new SyntaxClickAccumulator(page([], null, 0)).request(), null);
  assert.equal(new SyntaxClickAccumulator(page([point], null, 1)).request(), null);
});
