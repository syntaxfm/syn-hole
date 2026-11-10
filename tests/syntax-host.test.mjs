import test from "node:test";
import assert from "node:assert/strict";
import { parseSyntaxHostSets, syntaxHostControls, syntaxHostNow } from "../src/utils/syntax-host.ts";

const session = (phase, index = 0) => ({ phase, currentRound: { roundIndex: index }, totalRounds: 2, timing: { openedAt: 1000, deadlineAt: 11000 } });

test("launch and poll switching require safe terminal state", () => {
  assert.equal(syntaxHostControls(null, 0).launch, true);
  assert.equal(syntaxHostControls(null, 0).polls, false);
  for (const phase of ["prepared", "open", "closed", "revealed"]) {
    const controls = syntaxHostControls(session(phase), 12000);
    assert.equal(controls.launch, false);
    assert.equal(controls.polls, false);
    assert.equal(controls.abort, true);
  }
  for (const phase of ["finished", "aborted"]) {
    const controls = syntaxHostControls(session(phase), 0);
    assert.equal(controls.launch, true);
    assert.equal(controls.polls, true);
    assert.equal(controls.abort, false);
  }
});

test("no early reveal; deadline and server close permit manual reveal only", () => {
  assert.equal(syntaxHostControls(session("open"), 10999).reveal, false);
  assert.equal(syntaxHostControls(session("open"), 11000).reveal, true);
  assert.equal(syntaxHostControls(session("closed"), 0).reveal, true);
  assert.equal(syntaxHostControls(session("prepared"), 20000).reveal, false);
  assert.equal(syntaxHostControls(session("open"), 12000).remainingMs, 0);
  assert.equal(syntaxHostControls(session("open"), 10000).remainingMs, 1000);
});

test("start, next and finish follow authoritative phase and round count", () => {
  assert.equal(syntaxHostControls(session("prepared"), 0).start, true);
  assert.equal(syntaxHostControls(session("open"), 0).start, false);
  assert.equal(syntaxHostControls(session("revealed"), 0).next, true);
  assert.equal(syntaxHostControls(session("revealed"), 0).finish, false);
  assert.equal(syntaxHostControls(session("revealed", 1), 0).next, false);
  assert.equal(syntaxHostControls(session("revealed", 1), 0).finish, true);
});

test("clock uses elapsed monotonic time, not browser epoch or decrements", () => {
  assert.equal(syntaxHostNow(100000, 20, 1020), 101000);
  assert.equal(syntaxHostNow(100000, 20, 10), 100000);
  assert.equal(syntaxHostNow(150000, 3020, 3020), 150000); // reconnect resample
  assert.equal(syntaxHostControls(session("open"), syntaxHostNow(1000, 20, 20020)).remainingMs, 0); // suspended tab catches up
});

test("host set parser projects only safe summary fields and rejects malformed sets", () => {
  const safe = { id: "set-1", title: "Examples", defaultDurationMs: 10000, submissionMode: "confirm", roundCount: 5 };
  assert.deepEqual(parseSyntaxHostSets([{ ...safe, targets: [{ x: 1 }] }]), [safe]);
  assert.deepEqual(parseSyntaxHostSets([]), []);
  for (const bad of [null, {}, [null], [{ ...safe, roundCount: 0 }], [{ ...safe, defaultDurationMs: NaN }], [{ ...safe, submissionMode: "auto" }], [{ ...safe, id: "../secret" }]]) {
    assert.throws(() => parseSyntaxHostSets(bad), /invalid/);
  }
});
