import type { PollOptionImage, PollQuestion, RoomOptionImages } from "./types";
import {
  MAX_POLL_IMAGE_BYTES,
  getPollImageKey,
  getRoomImagePrefix,
  isImageQuestion,
  isPollImageContentType,
  isSafeKeySegment,
  parsePollImageDimension,
  parsePollImageKey,
  toPollOptionImage,
} from "./utils/poll-images";

function areSafeSegments(...segments: string[]): boolean {
  return segments.every(isSafeKeySegment);
}

async function listRoomObjects(bucket: R2Bucket, room: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    // The runtime honors `include` at our compatibility date; the default
    // workers-types entry point predates it, hence the widened type.
    const options: R2ListOptions & { include: Array<"customMetadata"> } = {
      prefix: getRoomImagePrefix(room),
      include: ["customMetadata"],
      cursor,
    };
    const page = await bucket.list(options);
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

/** Reads every option image for one question. A missing or unreadable image is left out. */
export async function loadOptionImages(
  bucket: R2Bucket,
  room: string,
  question: PollQuestion | null
): Promise<Record<string, PollOptionImage>> {
  if (!question || !isImageQuestion(question) || !isSafeKeySegment(room)) return {};

  const entries = await Promise.all(
    question.options.map(async (option) => {
      const object = await bucket.head(getPollImageKey(room, question.id, option.id));
      const image = object
        ? toPollOptionImage(room, question.id, option.id, object.customMetadata)
        : null;
      return [option.id, image] as const;
    })
  );

  const images: Record<string, PollOptionImage> = {};
  for (const [optionId, image] of entries) {
    if (image) images[optionId] = image;
  }
  return images;
}

export async function listRoomImages(bucket: R2Bucket, room: string): Promise<RoomOptionImages> {
  if (!isSafeKeySegment(room)) return {};
  const images: RoomOptionImages = {};
  for (const object of await listRoomObjects(bucket, room)) {
    const parsed = parsePollImageKey(room, object.key);
    if (!parsed) continue;
    const image = toPollOptionImage(room, parsed.questionId, parsed.optionId, object.customMetadata);
    if (!image) continue;
    images[parsed.questionId] ??= {};
    images[parsed.questionId][parsed.optionId] = { ...image, size: object.size };
  }
  return images;
}

/** Removes uploads whose question or option no longer exists, or is no longer an image question. */
export async function deleteUnusedRoomImages(
  bucket: R2Bucket,
  room: string,
  questions: PollQuestion[]
): Promise<void> {
  if (!isSafeKeySegment(room)) return;
  const usedKeys = new Set<string>();
  for (const question of questions) {
    if (!isImageQuestion(question)) continue;
    for (const option of question.options) {
      usedKeys.add(getPollImageKey(room, question.id, option.id));
    }
  }
  const unusedKeys = (await listRoomObjects(bucket, room))
    .map((object) => object.key)
    .filter((key) => !usedKeys.has(key));
  if (unusedKeys.length > 0) await bucket.delete(unusedKeys);
}

/** Makes `toRoom`'s images an exact copy of `fromRoom`'s. */
export async function copyRoomImages(bucket: R2Bucket, fromRoom: string, toRoom: string): Promise<void> {
  if (!areSafeSegments(fromRoom, toRoom)) throw new Error("Invalid room name for images.");

  const existingKeys = (await listRoomObjects(bucket, toRoom)).map((object) => object.key);
  if (existingKeys.length > 0) await bucket.delete(existingKeys);

  for (const object of await listRoomObjects(bucket, fromRoom)) {
    const parsed = parsePollImageKey(fromRoom, object.key);
    if (!parsed) continue;
    const source = await bucket.get(object.key);
    if (!source) continue;
    await bucket.put(getPollImageKey(toRoom, parsed.questionId, parsed.optionId), source.body, {
      httpMetadata: source.httpMetadata,
      customMetadata: source.customMetadata,
    });
  }
}

export async function servePollImage(
  bucket: R2Bucket,
  room: string,
  questionId: string,
  optionId: string
): Promise<Response> {
  if (!areSafeSegments(room, questionId, optionId)) return new Response("Not Found", { status: 404 });

  const object = await bucket.get(getPollImageKey(room, questionId, optionId));
  if (!object) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}

/**
 * Uploads may land before the editor's next autosave includes a new option,
 * so only the key format is checked here; deleteUnusedRoomImages tidies orphans on save.
 */
export async function uploadPollImage(
  bucket: R2Bucket,
  room: string,
  questionId: string,
  optionId: string,
  request: Request
): Promise<Response> {
  if (!areSafeSegments(room, questionId, optionId)) {
    return Response.json({ error: "Invalid room, question or option id." }, { status: 400 });
  }

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!isPollImageContentType(contentType)) {
    return Response.json({ error: "Use a JPEG, PNG, WebP, GIF or AVIF image." }, { status: 415 });
  }

  const width = parsePollImageDimension(request.headers.get("x-image-width"));
  const height = parsePollImageDimension(request.headers.get("x-image-height"));
  if (width === null || height === null) {
    return Response.json({ error: "Image width and height are required." }, { status: 400 });
  }

  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_POLL_IMAGE_BYTES) {
    return Response.json({ error: "Image is larger than 10 MB." }, { status: 413 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) {
    return Response.json({ error: "Image is empty." }, { status: 400 });
  }
  if (body.byteLength > MAX_POLL_IMAGE_BYTES) {
    return Response.json({ error: "Image is larger than 10 MB." }, { status: 413 });
  }

  const customMetadata = { width: String(width), height: String(height), uploadedAt: new Date().toISOString() };
  await bucket.put(getPollImageKey(room, questionId, optionId), body, {
    httpMetadata: { contentType },
    customMetadata,
  });

  const image = toPollOptionImage(room, questionId, optionId, customMetadata);
  return Response.json({ ok: true, image: image ? { ...image, size: body.byteLength } : null });
}

export async function deletePollImage(
  bucket: R2Bucket,
  room: string,
  questionId: string,
  optionId: string
): Promise<Response> {
  if (!areSafeSegments(room, questionId, optionId)) {
    return Response.json({ error: "Invalid room, question or option id." }, { status: 400 });
  }
  await bucket.delete(getPollImageKey(room, questionId, optionId));
  return Response.json({ ok: true });
}
