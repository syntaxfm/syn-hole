import test from "node:test";
import assert from "node:assert/strict";
import { createSyntaxDraft, syntaxDraftIssue, syntaxReviewIssue, syntaxUploadIssue, syntaxEntryEndpoint } from "../src/utils/syntax-editor.ts";
import { uploadWithProgress } from "../src/utils/files.ts";

test("incomplete drafts save but cannot review or launch", () => {
  const draft = createSyntaxDraft("entry");
  assert.equal(syntaxDraftIssue(draft), null);
  assert.match(syntaxReviewIssue(draft), /Upload/);
  assert.ok(syntaxDraftIssue({ ...draft, status: "reviewed" }));
});
test("review requires language, title, revision, image and valid targets", () => {
  const entry = { ...createSyntaxDraft("entry"), title: "Find typo", language: "CSS", imageRevisionId: "revision", image: { url: "/image", width: 200, height: 100, alt: "CSS" }, targets: [{ x: 0.5, y: 0.5, radius: 0.05 }], status: "reviewed" };
  assert.equal(syntaxDraftIssue(entry), null);
  for (const patch of [{ language: "" }, { title: "" }, { imageRevisionId: null }, { targets: [] }, { targets: [{ x: 2, y: 0, radius: 0.1 }] }]) assert.ok(syntaxReviewIssue({ ...entry, ...patch }));
});
test("draft validation rejects malformed targets and oversized text", () => {
  const draft = createSyntaxDraft("entry");
  assert.ok(syntaxDraftIssue({ ...draft, targets: [{ x: 0, y: 0, radius: 0 }] }));
  assert.ok(syntaxDraftIssue({ ...draft, title: "x".repeat(2001) }));
  assert.ok(syntaxDraftIssue({ ...draft, provenance: { ...draft.provenance, source: "x".repeat(2001) } }));
});
test("uploads use still raster allowlist and 10MiB bound", () => {
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) assert.equal(syntaxUploadIssue({ type, size: 10 * 1024 * 1024 }), null);
  for (const type of ["image/svg+xml", "image/avif", "text/plain"]) assert.ok(syntaxUploadIssue({ type, size: 100 }));
  assert.ok(syntaxUploadIssue({ type: "image/png", size: 0 }));
  assert.ok(syntaxUploadIssue({ type: "image/png", size: 10 * 1024 * 1024 + 1 }));
  assert.equal(syntaxEntryEndpoint("a/b"), "/api/admin/syntax/entries/a%2Fb");
});

test("shared upload helper supports route-change cancellation without changing existing callers", async () => {
  const original = globalThis.XMLHttpRequest;
  let request;
  class MockRequest extends EventTarget {
    upload = new EventTarget(); status = 200; responseText = '{"ok":true}';
    constructor() { super(); request = this; }
    open() {} setRequestHeader() {} send() {}
    abort() { this.dispatchEvent(new Event("abort")); this.dispatchEvent(new Event("loadend")); }
  }
  globalThis.XMLHttpRequest = MockRequest;
  const options = { method: "PUT", url: "/upload", body: new Blob(["image"]), headers: {}, onProgress() {} };
  try {
    const controller = new AbortController();
    const uploading = uploadWithProgress({ ...options, signal: controller.signal });
    controller.abort();
    await assert.rejects(uploading, /cancelled/);
    await assert.rejects(uploadWithProgress({ ...options, signal: controller.signal }), /cancelled/);
    const existingCaller = uploadWithProgress(options);
    request.dispatchEvent(new Event("load"));
    request.dispatchEvent(new Event("loadend"));
    assert.deepEqual(await existingCaller, { status: 200, body: { ok: true } });
  } finally { globalThis.XMLHttpRequest = original; }
});
