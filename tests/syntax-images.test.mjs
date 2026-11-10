import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { deflateSync } from "node:zlib";
import { inspectSyntaxImage, MAX_SYNTAX_IMAGE_BYTES } from "../src/syntax-game/image-validation.ts";
import { ensureSyntaxLibrarySchema, SyntaxLibraryStore } from "../src/syntax-game/library.ts";
import { routeSyntaxLibraryHttp } from "../src/syntax-game/library-http.ts";
import { readSyntaxImageBody, routeSyntaxImagesHttp, uploadSyntaxImage } from "../src/syntax-images.ts";

// Tiny real encoded, 3x2 still rasters. Generated once, not decoder dependencies.
const rasters = {
  "image/png": "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVR4nGOQ0zCCIAY4CwAbvALR0VZb3wAAAABJRU5ErkJggg==",
  "image/jpeg": "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAwT/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCDgKAP/9k=",
  "image/gif": "R0lGODlhAwACAIAAAExpcR4oMiH5BAUAAAAALAAAAAADAAIAAAICjF8AOw==",
  "image/webp": "UklGRi4AAABXRUJQVlA4ICIAAABwAQCdASoDAAIAAUAmJZQCdAFAAAD++ldotRJUvJ+iMAAA",
};
const png = Buffer.from(rasters["image/png"], "base64");
const imagePath = "/api/admin/syntax/entries/entry/image";

class Bucket {
  objects = new Map(); puts = []; deletions = []; failPut = false; collision = false;
  async put(key, bytes, options = {}) {
    this.puts.push(key);
    if (this.failPut) throw new Error("R2 offline");
    if (this.collision || (this.objects.has(key) && options.onlyIf?.etagDoesNotMatch === "*")) return null;
    this.objects.set(key, { key, bytes: new Uint8Array(bytes), size: bytes.byteLength, httpEtag: `"${key}"`, ...options });
    return this.head(key);
  }
  async head(key) { return this.objects.get(key) ?? null; }
  async get(key) {
    const object = await this.head(key);
    if (!object) return null;
    return { ...object, body: new ReadableStream({ start(controller) { controller.enqueue(object.bytes.slice()); controller.close(); } }) };
  }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) { this.deletions.push(key); this.objects.delete(key); } }
  async list({ prefix = "" } = {}) { return { objects: [...this.objects.values()].filter(object => object.key.startsWith(prefix)), truncated: false }; }
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: { exec(query, ...args) { const rows = db.prepare(query).all(...args); return { toArray: () => rows }; } },
    transactionSync(fn) {
      db.exec("BEGIN");
      try { const result = fn(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  ensureSyntaxLibrarySchema(storage.sql);
  const store = new SyntaxLibraryStore(storage);
  store.saveEntry({ id: "entry", title: "Screenshot", language: "typescript", status: "draft" }, true);
  const bucket = new Bucket();
  const registryFetch = request => store.fetch(request);
  const checkAdminAuth = request => request.headers.get("x-admin-key") === "secret" || new URL(request.url).searchParams.get("adminKey") === "secret" ? null : new Response("Unauthorized", { status: 401 });
  const deps = { bucket, registryFetch, checkAdminAuth, lookupHostKey: async () => "host" };
  const route = async request => await routeSyntaxImagesHttp(request, deps) ?? await routeSyntaxLibraryHttp(request, deps);
  return { db, storage, store, bucket, registryFetch, deps, route };
}
function request(path = imagePath, { method = "PUT", body = png, headers = {}, auth = true } = {}) {
  return new Request(`http://worker${path}`, { method, ...(method === "GET" || method === "HEAD" ? {} : { body }), headers: { "content-type": "image/png", ...(auth ? { "x-admin-key": "secret" } : {}), ...headers }, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) });
}
async function upload(f, options) {
  const response = await f.route(request(imagePath, options));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
function review(store) {
  const current = store.getEntry("entry");
  store.saveEntry({ ...current, status: "reviewed", targets: [{ x: 0.3, y: 0.2, radius: 0.05 }], explanation: "Private answer" }, false);
}

test("byte-derived dimensions and MIME for real still PNG/JPEG/GIF/WebP; truncation and spoofing fail", async () => {
  for (const [type, base64] of Object.entries(rasters)) {
    const bytes = Buffer.from(base64, "base64");
    assert.deepEqual(await inspectSyntaxImage(bytes, type), { width: 3, height: 2, contentType: type });
    for (let length = 0; length < bytes.length; length++) await assert.rejects(inspectSyntaxImage(bytes.subarray(0, length), type));
  }
  await assert.rejects(inspectSyntaxImage(png, "image/jpeg"), /does not match/);
  await assert.rejects(inspectSyntaxImage(Buffer.from("<svg onload='alert(1)'/>"), "image/png"), /Invalid/);
  await assert.rejects(inspectSyntaxImage(png, "image/svg+xml"), /not supported/);
  await assert.rejects(inspectSyntaxImage(png, "image/avif"), /not supported/);
});

test("palette/interlaced PNG and lossless/alpha WebP retain correct intrinsic dimensions", async () => {
  const variants = [
    ["image/png", "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAMAAACqqpYoAAAAA1BMVEUeKDIkSEyKAAAAAXRSTlOArV5bRgAAAAlwSFlzAAAD6AAAA+gBtXtSawAAAAtJREFUeJxjYIAAAAAIAAG3WHOVAAAAAElFTkSuQmCC"],
    ["image/png", "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAAHqc1aMAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGOQ0zBqYEAlYBgASwQF0fd94ykAAAAASUVORK5CYII="],
    ["image/webp", "UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAEAdQlHpUpoCBiOh/AAA="],
    ["image/webp", "UklGRlAAAABXRUJQVlA4WAoAAAAQAAAAAgAAAQAAQUxQSAcAAAAAgICAgICAAFZQOCAiAAAAcAEAnQEqAwACAAFAJiWUAnQBQAAA/vpXaLUSVLyfojAAAA=="],
  ];
  for (const [type, base64] of variants) assert.deepEqual(await inspectSyntaxImage(Buffer.from(base64, "base64"), type), { width: 3, height: 2, contentType: type });
});

function pngChunk(kind, body) {
  const type = Buffer.from(kind);
  const content = Buffer.concat([type, body]);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, content, checksum]);
}
function makePng({ width = 3, height = 2, raw = Buffer.alloc(20), idat = deflateSync(raw), extra = [] } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([png.subarray(0, 8), pngChunk("IHDR", ihdr), ...extra, pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

test("PNG validates CRC, scanline length/filter, decompression, dimensions and rejects animation", async () => {
  assert.equal((await inspectSyntaxImage(makePng(), "image/png")).width, 3);
  const badCrc = Buffer.from(png); badCrc[20] ^= 1;
  const filter = Buffer.alloc(20); filter[0] = 5;
  for (const bad of [badCrc, makePng({ width: 20001 }), makePng({ width: 5000, height: 5000 }), makePng({ width: 0 }), makePng({ raw: Buffer.alloc(19) }), makePng({ raw: Buffer.alloc(21) }), makePng({ raw: Buffer.alloc(1024 * 1024) }), makePng({ raw: filter }), makePng({ idat: Buffer.from("not deflate") }), makePng({ extra: [pngChunk("acTL", Buffer.alloc(8))] }), Buffer.concat([png, Buffer.from("extra")])]) {
    await assert.rejects(inspectSyntaxImage(bad, "image/png"));
  }
});

test("JPEG/GIF/WebP bound dimensions and reject conflicting containers/EXIF orientation", async () => {
  const jpeg = Buffer.from(rasters["image/jpeg"], "base64");
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  const huge = Buffer.from(jpeg); huge.writeUInt16BE(20001, sof + 7);
  await assert.rejects(inspectSyntaxImage(huge, "image/jpeg"), /dimensions/);
  const exif = Buffer.from("45786966000049492a0008000000010012010300010000000600000000000000", "hex");
  const app = Buffer.alloc(4); app[0] = 0xff; app[1] = 0xe1; app.writeUInt16BE(exif.length + 2, 2);
  await assert.rejects(inspectSyntaxImage(Buffer.concat([jpeg.subarray(0, 2), app, exif, jpeg.subarray(2)]), "image/jpeg"), /orientation/);
  const gif = Buffer.from(rasters["image/gif"], "base64"); gif.writeUInt16LE(0, 6);
  await assert.rejects(inspectSyntaxImage(gif, "image/gif"), /dimensions/);
  const webp = Buffer.from(rasters["image/webp"], "base64");
  const canvas = Buffer.alloc(18); canvas.write("VP8X"); canvas.writeUInt32LE(10, 4); canvas[12] = 8; canvas[15] = 1;
  const conflict = Buffer.concat([webp.subarray(0, 12), canvas, webp.subarray(12)]); conflict.writeUInt32LE(conflict.length - 8, 4);
  await assert.rejects(inspectSyntaxImage(conflict, "image/webp"), /Invalid/);
  const animated = Buffer.from(conflict); animated[20] = 2;
  await assert.rejects(inspectSyntaxImage(animated, "image/webp"), /Invalid/);
});

test("stream reader bounds chunked and dishonest lengths, cancels early and handles interruption", async () => {
  let canceled = false, produced = 0;
  const oversized = new ReadableStream({ pull(controller) { produced++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { canceled = true; } });
  await assert.rejects(readSyntaxImageBody(request(imagePath, { body: oversized })), error => error.status === 413);
  assert.ok(canceled); assert.ok(produced <= 12);
  let canceledHeader = false;
  const declaredOversize = new ReadableStream({ cancel() { canceledHeader = true; } });
  await assert.rejects(readSyntaxImageBody(request(imagePath, { body: declaredOversize, headers: { "content-length": String(MAX_SYNTAX_IMAGE_BYTES + 1) } })), error => error.status === 413);
  assert.ok(canceledHeader);
  for (const headers of [{ "content-length": "nope" }, { "content-length": "1" }]) await assert.rejects(readSyntaxImageBody(request(imagePath, { headers })), /Content-Length/);
  await assert.rejects(readSyntaxImageBody(request(imagePath, { body: new Uint8Array() })), /empty/);
  const broken = new ReadableStream({ start(controller) { controller.error(new Error("connection lost")); } });
  await assert.rejects(readSyntaxImageBody(request(imagePath, { body: broken })), /interrupted/);
  assert.deepEqual(await readSyntaxImageBody(request()), new Uint8Array(png));
});

test("admin upload auth, invalid bytes/MIME/dimensions, missing entries, and explicit trusted-only registration", async () => {
  const f = fixture();
  assert.equal((await f.route(request(imagePath, { auth: false }))).status, 401);
  assert.equal((await f.route(request(imagePath, { auth: false, headers: { "x-admin-key": "wrong" } }))).status, 401);
  assert.equal((await f.route(request(imagePath, { method: "DELETE", auth: false }))).status, 401);
  assert.equal((await f.route(request(imagePath, { method: "POST" }))).status, 405);
  assert.equal((await f.route(request(imagePath, { headers: { "content-type": "image/svg+xml" } }))).status, 415);
  assert.equal((await f.route(request(imagePath, { headers: { "content-type": "image/jpeg" } }))).status, 415);
  assert.equal((await f.route(request(imagePath, { headers: { "x-image-width": "4", "x-image-height": "2" } }))).status, 400);
  assert.equal((await f.route(request(imagePath, { headers: { "x-image-width": "3evil" } }))).status, 400);
  assert.equal((await f.route(request(imagePath, { body: new Uint8Array() }))).status, 400);
  assert.equal((await f.route(request(imagePath, { body: Buffer.from("not an image") }))).status, 400);
  assert.equal((await f.route(request(imagePath, { headers: { "content-length": String(MAX_SYNTAX_IMAGE_BYTES + 1) } }))).status, 413);
  assert.equal((await f.route(request("/api/admin/syntax/entries/missing/image"))).status, 404);
  assert.equal((await f.route(request("/api/admin/syntax/entries/missing/image", { method: "DELETE" }))).status, 404);
  assert.equal((await f.route(request("/api/admin/syntax/entries/bad%2Fid/image"))).status, 400);
  assert.equal((await f.route(request("/api/admin/syntax/entries/%xx/image"))).status, 400);
  assert.equal(f.bucket.puts.length, 0);
  // Public/admin JSON cannot self-register immutable bytes: PUT here is raster,
  // and other internal metadata APIs are not forwarded by the library router.
  assert.equal((await f.route(request(imagePath, { body: JSON.stringify({ id: "fake" }), headers: { "content-type": "application/json" } }))).status, 415);
  assert.equal((await f.route(request("/api/admin/syntax/image-revisions", { headers: { "content-type": "application/json" } }))).status, 404);
  const queryAuth = await f.route(request(`${imagePath}?adminKey=secret`, { auth: false, headers: { "x-image-width": "3", "x-image-height": "2" } }));
  assert.equal(queryAuth.status, 200);
  const uploaded = await queryAuth.json();
  assert.equal(uploaded.ok, true);
});

test("all supported raster uploads return image-only metadata and derived intrinsic dimensions", async () => {
  for (const [contentType, base64] of Object.entries(rasters)) {
    const f = fixture();
    const bytes = Buffer.from(base64, "base64");
    const body = await upload(f, { body: bytes, headers: { "content-type": contentType } });
    assert.deepEqual(Object.keys(body).sort(), ["image", "imageRevisionId", "ok", "status"]);
    assert.match(body.imageRevisionId, /^[a-f\d-]{36}$/);
    assert.deepEqual(body.image, { url: `/api/syntax/images/entry/${body.imageRevisionId}`, width: 3, height: 2, alt: "Code screenshot", size: bytes.length, contentType });
    const [key] = f.bucket.objects.keys();
    assert.equal(key, `syntax/entry/${body.imageRevisionId}`);
    assert.deepEqual(f.bucket.objects.get(key).customMetadata, { width: "3", height: "2" });
    assert.deepEqual(f.bucket.objects.get(key).onlyIf, { etagDoesNotMatch: "*" });
    assert.equal(f.store.getEntry("entry").imageRevisionId, body.imageRevisionId);
    assert.equal(body.status, "draft");
  }
});

test("replacement/removal invalidate review and targets; old snapshots/assets remain exact; stale saves conflict", async () => {
  const f = fixture();
  const first = await upload(f);
  review(f.store);
  const oldAuthoring = f.store.getEntry("entry");
  f.store.saveSet({ id: "set", title: "Set", rounds: [{ entryId: "entry" }] }, true);
  const snapshot = f.store.prepareSnapshot("set", { id: "session", askPlayMode: false });
  const second = await upload(f, { body: makePng() });
  assert.notEqual(first.imageRevisionId, second.imageRevisionId);
  assert.notEqual(first.image.url, second.image.url);
  const current = f.store.getEntry("entry");
  assert.equal(current.status, "draft"); assert.deepEqual(current.targets, []); assert.equal(current.explanation, "");
  assert.throws(() => f.store.prepareSnapshot("set", { id: "blocked", askPlayMode: false }), /reviewed/);
  assert.throws(() => f.store.saveEntry(oldAuthoring, false), /Image changed/);
  const { imageRevisionId: oldRevision, ...reviewWithoutRevision } = oldAuthoring;
  assert.throws(() => f.store.saveEntry(reviewWithoutRevision, false), /explicitly identify/);
  assert.throws(() => f.store.saveEntry({ ...current, imageRevisionId: null }, false), /Image changed/);
  assert.equal((await (await f.route(request(first.image.url, { method: "GET", auth: false }))).arrayBuffer()).byteLength, png.length);
  assert.equal(f.store.getSnapshot("session").rounds[0].entry.image.url, first.image.url);
  assert.deepEqual(f.store.getSnapshot("session"), snapshot);
  review(f.store);
  const removed = await f.route(request(imagePath, { method: "DELETE" }));
  assert.deepEqual(await removed.json(), { ok: true, imageRevisionId: null, image: null, status: "draft" });
  const detached = f.store.getEntry("entry");
  assert.equal(detached.image, null); assert.deepEqual(detached.targets, []); assert.equal(detached.explanation, "");
  assert.equal((await f.route(request(second.image.url, { method: "GET", auth: false }))).status, 200);
  f.store.deleteSet("set"); f.store.deleteEntry("entry");
  assert.equal((await f.route(request(first.image.url, { method: "GET", auth: false }))).status, 200);
  assert.deepEqual(f.store.getSnapshot("session"), snapshot);
  assert.equal(f.bucket.objects.size, 2); assert.deepEqual(f.bucket.deletions, []);
});

test("public GET/HEAD conditional immutable caching, correct MIME, missing assets and metadata allowlist", async () => {
  const f = fixture(); const uploaded = await upload(f);
  const key = `syntax/entry/${uploaded.imageRevisionId}`;
  f.bucket.objects.get(key).customMetadata.targets = "PRIVATE";
  const get = await f.route(request(uploaded.image.url, { method: "GET", auth: false }));
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(get.headers.get("content-type"), "image/png");
  assert.equal(get.headers.get("x-image-width"), "3"); assert.equal(get.headers.get("x-image-height"), "2");
  assert.equal(get.headers.get("x-content-type-options"), "nosniff");
  assert.ok(!JSON.stringify([...get.headers]).includes("PRIVATE"));
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), png);
  const head = await f.route(request(uploaded.image.url, { method: "HEAD", auth: false }));
  assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0); assert.equal(head.headers.get("content-length"), String(png.length));
  const cached = await f.route(request(uploaded.image.url, { method: "GET", auth: false, headers: { "if-none-match": `"unrelated", W/${get.headers.get("etag")}` } }));
  assert.equal(cached.status, 304); assert.equal((await cached.arrayBuffer()).byteLength, 0);
  assert.equal((await f.route(request(uploaded.image.url, { method: "PUT", auth: false }))).status, 405);
  assert.equal((await f.route(request("/api/syntax/images/entry/missing", { method: "GET", auth: false }))).status, 404);
  assert.equal((await f.route(request("/api/syntax/images/bad%2Fid/rev", { method: "GET", auth: false }))).status, 404);
  assert.equal((await f.route(request("/api/syntax/images/%xx/rev", { method: "GET", auth: false }))).status, 404);
  f.bucket.objects.get(key).httpMetadata.contentType = "text/html";
  assert.equal((await f.route(request(uploaded.image.url, { method: "GET", auth: false }))).status, 404);
});

test("R2/registry failures never delete possibly published bytes; attachment transaction rollback and collision are safe", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const f = fixture();
  f.bucket.failPut = true;
  assert.equal((await f.route(request())).status, 503);
  assert.equal(f.store.getEntry("entry").imageRevisionId, null);
  f.bucket.failPut = false; f.bucket.collision = true;
  assert.equal((await f.route(request())).status, 409);
  assert.equal(f.store.getEntry("entry").imageRevisionId, null);
  f.bucket.collision = false;
  const failAfterCommit = async req => {
    const response = await f.registryFetch(req);
    if (req.method === "PUT") throw new Error("reply lost after commit");
    return response;
  };
  assert.equal((await uploadSyntaxImage(f.bucket, failAfterCommit, "entry", request())).status, 503);
  const committed = f.store.getEntry("entry");
  assert.ok(committed.imageRevisionId);
  assert.ok(f.bucket.objects.has(`syntax/entry/${committed.imageRevisionId}`));
  assert.equal((await f.route(request(committed.image.url, { method: "GET", auth: false }))).status, 200);
  const before = f.store.getEntry("entry");
  const revision = { id: "rollback", entryId: "entry", key: "syntax/entry/rollback", image: { url: "/api/syntax/images/entry/rollback", width: 3, height: 2, alt: "Code screenshot" } };
  const original = f.storage.sql.exec;
  f.storage.sql.exec = (query, ...args) => { if (query.startsWith("INSERT INTO syntax_entries")) throw new Error("SQLITE failure"); return original(query, ...args); };
  assert.throws(() => f.store.attachImageRevision("entry", revision), /SQLITE/);
  f.storage.sql.exec = original;
  assert.deepEqual(f.store.getEntry("entry"), before);
  assert.deepEqual(f.storage.sql.exec("SELECT id FROM syntax_image_revisions WHERE id = ?", "rollback").toArray(), []);
  const failBeforeCommit = async req => req.method === "PUT" ? new Response("unavailable", { status: 500 }) : f.registryFetch(req);
  assert.equal((await uploadSyntaxImage(f.bucket, failBeforeCommit, "entry", request())).status, 503);
  assert.deepEqual(f.store.getEntry("entry"), before);
  assert.equal(f.bucket.objects.size, 2); assert.deepEqual(f.bucket.deletions, []);
  const deletedDuringUpload = async req => { if (req.method === "PUT") f.store.deleteEntry("entry"); return f.registryFetch(req); };
  assert.equal((await uploadSyntaxImage(f.bucket, deletedDuringUpload, "entry", request())).status, 404);
  assert.equal(f.bucket.objects.size, 3); assert.deepEqual(f.bucket.deletions, []);
  assert.equal(logged.mock.calls.length, 4);
});

test("internal attachment retry is idempotent and cannot erase later review work", async () => {
  const f = fixture(); const first = await upload(f); review(f.store);
  const current = f.store.getEntry("entry");
  const revision = { id: first.imageRevisionId, entryId: "entry", key: `syntax/entry/${first.imageRevisionId}`, image: current.image };
  const response = await f.registryFetch(new Request("http://internal/syntax/entries/entry/image", { method: "PUT", body: JSON.stringify(revision) }));
  assert.equal(response.status, 200);
  assert.deepEqual(f.store.getEntry("entry"), current);
  assert.ok(!JSON.stringify(await response.json()).includes("Private answer"));
  assert.equal((await f.route(request(imagePath, { method: "DELETE" }))).status, 200);
  assert.equal((await f.route(request(imagePath, { method: "DELETE" }))).status, 200);
});

test("syntax namespace is isolated from existing poll upload/copy/cleanup behavior", async () => {
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "./utils/poll-images") return next(new URL("../src/utils/poll-images.ts", import.meta.url).href, context);
    return next(specifier, context);
  } });
  try {
    const { uploadPollImage, deleteUnusedRoomImages, copyRoomImages, deletePollImage } = await import("../src/poll-images.ts");
    const f = fixture(); const syntax = await upload(f);
    const response = await uploadPollImage(f.bucket, "from", "question", "option", request(imagePath, { headers: { "x-image-width": "3", "x-image-height": "2" } }));
    assert.equal(response.status, 200);
    // poll copy streams bodies, whereas syntax uploads use a bounded byte array.
    const put = f.bucket.put.bind(f.bucket);
    f.bucket.put = async (key, body, opts) => put(key, body instanceof ReadableStream ? await new Response(body).arrayBuffer() : body, opts);
    await copyRoomImages(f.bucket, "from", "to");
    assert.ok(f.bucket.objects.has("poll-images/to/question/option"));
    await deleteUnusedRoomImages(f.bucket, "from", []);
    await deletePollImage(f.bucket, "to", "question", "option");
    await deleteUnusedRoomImages(f.bucket, "syntax", []);
    assert.ok(f.bucket.objects.has(`syntax/entry/${syntax.imageRevisionId}`));
    assert.ok(f.bucket.deletions.every(key => key.startsWith("poll-images/")));
    assert.equal((await f.route(request(syntax.image.url, { method: "GET", auth: false }))).status, 200);
  } finally { hook.deregister(); }
});
