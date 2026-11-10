import test from "node:test";
import assert from "node:assert/strict";
import { createSyntaxSetDraft, parseSyntaxSetDraft, syntaxSetToDraft, syntaxSetDraftIssue, syntaxSetLaunchIssues, syntaxSetEndpoint } from "../src/utils/syntax-sets.ts";
import { createSyntaxDraft } from "../src/utils/syntax-editor.ts";
import { moveItem } from "../src/utils/questions.ts";

const member = id => ({ ...createSyntaxDraft(id), title: `Screenshot ${id}`, language: "CSS", status: "reviewed", imageRevisionId: `revision-${id}`, image: { url: `/images/${id}`, width: 200, height: 100, alt: "Code" }, targets: [{ x: 0.5, y: 0.5, radius: 0.05 }] });
const valid = () => ({ ...createSyntaxSetDraft("set"), title: "CSS examples", rounds: [{ entryId: "a", seconds: "" }, { entryId: "b", seconds: "1.125" }] });

test("new empty draft stays local and nonlaunchable", () => {
  const draft = createSyntaxSetDraft("new");
  assert.equal(draft.defaultSeconds, "30");
  assert.match(syntaxSetDraftIssue(draft), /Empty sets/);
  assert.ok(syntaxSetLaunchIssues(draft, []).length);
});
test("set serialization preserves title, order, overrides and default submission style", () => {
  const draft = valid();
  const set = parseSyntaxSetDraft(draft);
  assert.equal(set.defaultDurationMs, 30000);
  assert.equal(set.submissionMode, "first-click");
  assert.deepEqual(set.rounds, [{ entryId: "a" }, { entryId: "b", durationMs: 1125 }]);
  assert.deepEqual(syntaxSetToDraft(set), draft);
  assert.equal(parseSyntaxSetDraft({ ...draft, submissionMode: "confirm" }).submissionMode, "confirm");
});
test("incomplete, nonfinite, out-of-bounds and submillisecond timing never saves", () => {
  for (const seconds of ["", "0", "301", "Infinity", "NaN", "-2", "1.0001"]) assert.ok(syntaxSetDraftIssue({ ...valid(), defaultSeconds: seconds }), seconds);
  for (const seconds of ["0", "301", "NaN", "1.0001"]) assert.ok(syntaxSetDraftIssue({ ...valid(), rounds: [{ entryId: "a", seconds }] }));
  assert.equal(syntaxSetDraftIssue({ ...valid(), defaultSeconds: "300", rounds: [{ entryId: "a", seconds: "1" }] }), null);
});
test("duplicates and invalid titles rejected without altering drafts", () => {
  assert.match(syntaxSetDraftIssue({ ...valid(), rounds: [{ entryId: "a", seconds: "" }, { entryId: "a", seconds: "" }] }), /only once/);
  assert.ok(syntaxSetDraftIssue({ ...valid(), title: "" }));
  assert.ok(syntaxSetDraftIssue({ ...valid(), title: "x".repeat(2001) }));
});
test("arrow ordering and removal preserve per-round timing and library IDs", () => {
  const draft = valid();
  const moved = { ...draft, rounds: moveItem(draft.rounds, 1, 0) };
  assert.deepEqual(parseSyntaxSetDraft(moved).rounds, [{ entryId: "b", durationMs: 1125 }, { entryId: "a" }]);
  assert.equal(draft.rounds[0].entryId, "a");
  assert.deepEqual(parseSyntaxSetDraft({ ...moved, rounds: moved.rounds.slice(1) }).rounds, [{ entryId: "a" }]);
});
test("missing and changed members block launch but are never silently dropped", () => {
  const draft = valid();
  assert.deepEqual(syntaxSetLaunchIssues(draft, [member("a"), member("b")]), []);
  assert.match(syntaxSetLaunchIssues(draft, [member("a")])[0], /Round 2.*missing/);
  assert.match(syntaxSetLaunchIssues(draft, [member("a"), { ...member("b"), status: "draft" }])[0], /unreviewed/);
  assert.ok(syntaxSetLaunchIssues(draft, [member("a"), { ...member("b"), image: null }]).length);
  assert.ok(syntaxSetLaunchIssues(draft, [member("a"), { ...member("b"), targets: [] }]).length);
  assert.equal(draft.rounds.length, 2);
  assert.equal(syntaxSetDraftIssue(draft), null, "launch warnings do not prevent saving existing unreviewed members");
  assert.equal(syntaxSetEndpoint("a/b"), "/api/admin/syntax/sets/a%2Fb");
});
