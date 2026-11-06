import type {
  AdminPollImageQuestion,
  PollOptionImage,
  PollQuestion,
} from "./types";
import {
  MAX_POLL_IMAGE_BYTES,
  getPollImageKey,
  isImageQuestion,
  isPollImageContentType,
  isPollImageId,
  parsePollImageDimension,
  toPollOptionImage,
} from "./utils/poll-images";

function isImageQuestionOption(
  questions: PollQuestion[],
  questionId: string,
  optionId: string
): boolean {
  if (!isPollImageId(questionId) || !isPollImageId(optionId)) return false;
  const question = questions.find((item) => item.id === questionId);
  if (!question || !isImageQuestion(question)) return false;
  return question.options.some((option) => option.id === optionId);
}

/** Reads every option image for one question. A missing or unreadable image is left out. */
export async function loadOptionImages(
  bucket: R2Bucket,
  question: PollQuestion | null
): Promise<Record<string, PollOptionImage>> {
  if (!question || !isImageQuestion(question)) return {};

  const entries = await Promise.all(
    question.options.map(async (option) => {
      const object = await bucket.head(getPollImageKey(question.id, option.id));
      const image = object ? toPollOptionImage(question.id, option.id, object.customMetadata) : null;
      return [option.id, image] as const;
    })
  );

  const images: Record<string, PollOptionImage> = {};
  for (const [optionId, image] of entries) {
    if (image) images[optionId] = image;
  }
  return images;
}

export async function servePollImage(
  bucket: R2Bucket,
  questions: PollQuestion[],
  questionId: string,
  optionId: string
): Promise<Response> {
  if (!isImageQuestionOption(questions, questionId, optionId)) return new Response("Not Found", { status: 404 });

  const object = await bucket.get(getPollImageKey(questionId, optionId));
  if (!object) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}

export async function listAdminPollImages(
  bucket: R2Bucket,
  questions: PollQuestion[]
): Promise<AdminPollImageQuestion[]> {
  const imageQuestions: AdminPollImageQuestion[] = [];

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    if (!isImageQuestion(question)) continue;

    const options = await Promise.all(
      question.options.map(async (option) => {
        const object = await bucket.head(getPollImageKey(question.id, option.id));
        const image = object ? toPollOptionImage(question.id, option.id, object.customMetadata) : null;
        return {
          id: option.id,
          label: option.label,
          image: image && object ? { ...image, size: object.size } : null,
        };
      })
    );

    imageQuestions.push({
      index,
      id: question.id,
      prompt: question.prompt,
      correctOptionIds: [...question.correctOptionIds],
      options,
    });
  }

  return imageQuestions;
}

export async function uploadPollImage(
  bucket: R2Bucket,
  questions: PollQuestion[],
  questionId: string,
  optionId: string,
  request: Request
): Promise<Response> {
  if (!isImageQuestionOption(questions, questionId, optionId)) {
    return Response.json({ error: "Unknown image question or option." }, { status: 404 });
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

  const uploadedAt = new Date().toISOString();
  await bucket.put(getPollImageKey(questionId, optionId), body, {
    httpMetadata: { contentType },
    customMetadata: { width: String(width), height: String(height), uploadedAt },
  });

  const image = toPollOptionImage(questionId, optionId, {
    width: String(width),
    height: String(height),
    uploadedAt,
  });
  return Response.json({ ok: true, image: image ? { ...image, size: body.byteLength } : null });
}

export async function deletePollImage(
  bucket: R2Bucket,
  questions: PollQuestion[],
  questionId: string,
  optionId: string
): Promise<Response> {
  if (!isImageQuestionOption(questions, questionId, optionId)) {
    return Response.json({ error: "Unknown image question or option." }, { status: 404 });
  }
  await bucket.delete(getPollImageKey(questionId, optionId));
  return Response.json({ ok: true });
}
