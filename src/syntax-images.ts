import { parseSyntaxId } from "~/syntax-game/validation";
import { inspectSyntaxImage, MAX_SYNTAX_IMAGE_BYTES, MAX_SYNTAX_IMAGE_PIXELS, SYNTAX_IMAGE_TYPES, SyntaxImageError } from "~/syntax-game/image-validation";
import { MAX_POLL_IMAGE_DIMENSION } from "~/utils/poll-images";

type RegistryFetch = (request: Request) => Promise<Response>;
type Dependencies = { bucket: R2Bucket; registryFetch: RegistryFetch; checkAdminAuth(request: Request): Response | null };
function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}
function validId(value: string): boolean {
  try { return parseSyntaxId(value) === value; } catch { return false; }
}

/** Bound while streaming, including chunked requests and dishonest/missing
 * Content-Length. At most 10 MiB is retained; the source is canceled on failure. */
export async function readSyntaxImageBody(request: Request): Promise<Uint8Array> {
  const rawLength = request.headers.get("content-length");
  if (rawLength !== null && !/^\d+$/.test(rawLength)) throw new SyntaxImageError("Invalid Content-Length.");
  const declared = rawLength === null ? null : Number(rawLength);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared > MAX_SYNTAX_IMAGE_BYTES)) {
    await request.body?.cancel().catch(() => {});
    throw new SyntaxImageError("Image is larger than 10 MB.", 413);
  }
  if (!request.body) throw new SyntaxImageError("Image is empty.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new SyntaxImageError("Invalid image upload stream.");
      if (!value.byteLength) continue;
      if (length + value.byteLength > MAX_SYNTAX_IMAGE_BYTES) throw new SyntaxImageError("Image is larger than 10 MB.", 413);
      // The input producer may reuse its buffer, so keep our own bounded copy.
      chunks.push(value.slice()); length += value.byteLength;
    }
    if (!length) throw new SyntaxImageError("Image is empty.");
    if (declared !== null && declared !== length) throw new SyntaxImageError("Content-Length does not match the upload.");
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    if (error instanceof SyntaxImageError) throw error;
    throw new SyntaxImageError("Image upload was interrupted.");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function checkClientDimensions(request: Request, actual: { width: number; height: number }): void {
  for (const name of ["width", "height"] as const) {
    const value = request.headers.get(`x-image-${name}`);
    if (value !== null && (!/^[1-9]\d*$/.test(value) || Number(value) !== actual[name])) throw new SyntaxImageError(`x-image-${name} does not match the image bytes.`);
  }
}

/** Raw PUTs work with uploadWithProgress/XHR. No multipart envelope is needed.
 * A successful PUT stores bytes BEFORE the trusted atomic registry attachment.
 * Never delete on an uncertain registry result: its transaction may have already
 * committed. Initially retain ALL revisions (including uncertain orphans); a
 * future reconciler must prove an object was never published before removing it. */
export async function uploadSyntaxImage(bucket: R2Bucket, registryFetch: RegistryFetch, entryId: string, request: Request): Promise<Response> {
  if (!validId(entryId)) return jsonError("Invalid entry id.", 400);
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!(SYNTAX_IMAGE_TYPES as readonly string[]).includes(contentType)) return jsonError("Use a still PNG, JPEG, GIF or WebP screenshot (SVG and AVIF are not supported).", 415);
  try {
    const exists = await registryFetch(new Request(`http://internal/syntax/entries/${entryId}`));
    await exists.body?.cancel();
    if (!exists.ok) return jsonError(exists.status === 404 ? "Library entry not found. Save a draft before uploading." : "Could not read library entry.", exists.status === 404 ? 404 : 503);
    const bytes = await readSyntaxImageBody(request);
    const decoded = await inspectSyntaxImage(bytes, contentType);
    checkClientDimensions(request, decoded);
    const revisionId = crypto.randomUUID();
    const key = `syntax/${entryId}/${revisionId}`;
    const image = { url: `/api/syntax/images/${entryId}/${revisionId}`, width: decoded.width, height: decoded.height, alt: "Code screenshot" };
    const object = await bucket.put(key, bytes, {
      // UUID generation plus a storage precondition: never overwrite any bytes,
      // even in the event of a collision or an accidentally reused request id.
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: decoded.contentType, cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { width: String(decoded.width), height: String(decoded.height) },
    });
    if (!object) return jsonError("Image revision collision; retry the upload.", 409);
    let attached: Response;
    try {
      attached = await registryFetch(new Request(`http://internal/syntax/entries/${entryId}/image`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: revisionId, entryId, key, image }),
      }));
    } catch {
      console.error("Syntax image stored but registry result is unknown; retained revision", key);
      return jsonError("Image stored, but attachment could not be confirmed. Reload the entry before retrying.", 503);
    }
    await attached.body?.cancel();
    if (!attached.ok) {
      console.error("Syntax image attachment failed; retained orphan revision", key, attached.status);
      return jsonError("Image stored but could not be attached. Reload the entry before retrying.", attached.status === 404 ? 404 : 503);
    }
    // The registry response is internal; construct an explicit client allowlist.
    return Response.json({ ok: true, imageRevisionId: revisionId, image: { ...image, size: bytes.byteLength, contentType: decoded.contentType }, status: "draft" }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof SyntaxImageError) return jsonError(error.message, error.status);
    console.error("Syntax image upload failed", error);
    return jsonError("Could not store image. Reload the entry before retrying.", 503);
  }
}

export async function removeSyntaxImage(registryFetch: RegistryFetch, entryId: string): Promise<Response> {
  if (!validId(entryId)) return jsonError("Invalid entry id.", 400);
  try {
    const response = await registryFetch(new Request(`http://internal/syntax/entries/${entryId}/image`, { method: "DELETE" }));
    await response.body?.cancel();
    if (!response.ok) return jsonError(response.status === 404 ? "Library entry not found." : "Could not remove current image.", response.status === 404 ? 404 : 503);
    return Response.json({ ok: true, imageRevisionId: null, image: null, status: "draft" }, { headers: { "cache-control": "no-store" } });
  } catch { return jsonError("Could not remove current image. Reload the entry before retrying.", 503); }
}

/** Public assets are intentionally preloadable. Hiding a future image in the UI
 * is visual preparation, not anti-cheat secrecy. No answer metadata is served. */
export async function serveSyntaxImage(bucket: R2Bucket, entryId: string, revisionId: string, request: Request): Promise<Response> {
  if (!validId(entryId) || !validId(revisionId)) return new Response("Not Found", { status: 404 });
  const key = `syntax/${entryId}/${revisionId}`;
  const object = request.method === "HEAD" ? await bucket.head(key) : await bucket.get(key);
  if (!object) return new Response("Not Found", { status: 404 });
  const body = request.method === "HEAD" ? null : (object as R2ObjectBody).body;
  const contentType = object.httpMetadata?.contentType;
  const w = object.customMetadata?.width ?? "", h = object.customMetadata?.height ?? "";
  if (!contentType || !(SYNTAX_IMAGE_TYPES as readonly string[]).includes(contentType) || !/^[1-9]\d*$/.test(w) || !/^[1-9]\d*$/.test(h) || Number(w) > MAX_POLL_IMAGE_DIMENSION || Number(h) > MAX_POLL_IMAGE_DIMENSION || Number(w) * Number(h) > MAX_SYNTAX_IMAGE_PIXELS) {
    await body?.cancel();
    return new Response("Not Found", { status: 404 });
  }
  const headers = new Headers({
    "content-type": contentType, "content-length": String(object.size), "etag": object.httpEtag,
    "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff",
    "x-image-width": w, "x-image-height": h,
  });
  const matches = request.headers.get("if-none-match")?.split(",").map(value => value.trim().replace(/^W\//, ""));
  if (matches?.includes(object.httpEtag) || matches?.includes("*")) {
    await body?.cancel();
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { headers });
}

/** Must run before the generic library router, whose strict allowlist deliberately
 * does not forward internal image-registration operations from client JSON. */
export async function routeSyntaxImagesHttp(request: Request, deps: Dependencies): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const admin = path.match(/^\/api\/admin\/syntax\/entries\/([^/]+)\/image$/);
  if (admin) {
    const auth = deps.checkAdminAuth(request);
    if (auth) return auth;
    let id: string;
    try { id = decodeURIComponent(admin[1]); } catch { return jsonError("Invalid entry id.", 400); }
    if (request.method === "PUT") return uploadSyntaxImage(deps.bucket, deps.registryFetch, id, request);
    if (request.method === "DELETE") return removeSyntaxImage(deps.registryFetch, id);
    return jsonError("Method not allowed.", 405);
  }
  const publicImage = path.match(/^\/api\/syntax\/images\/([^/]+)\/([^/]+)$/);
  if (!publicImage) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return jsonError("Method not allowed.", 405);
  try { return await serveSyntaxImage(deps.bucket, decodeURIComponent(publicImage[1]), decodeURIComponent(publicImage[2]), request); }
  catch (error) { if (error instanceof URIError) return new Response("Not Found", { status: 404 }); throw error; }
}
