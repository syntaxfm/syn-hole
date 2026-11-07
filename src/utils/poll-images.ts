import type {
  PollChoiceQuestion,
  PollChoiceQuestionPublic,
  PollOptionImage,
  PollQuestion,
  PollQuestionPublic,
  RoomOptionImages,
} from "~/types";

export const POLL_IMAGE_KEY_PREFIX = "poll-images";
export const MAX_POLL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_POLL_IMAGE_DIMENSION = 20_000;

/** SVG is excluded on purpose: it can carry script and is served from our origin. */
export const POLL_IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;

const SAFE_KEY_SEGMENT_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Room names, question ids and option ids become R2 key segments, so they must match this. */
export function isSafeKeySegment(value: string): boolean {
  return SAFE_KEY_SEGMENT_PATTERN.test(value);
}

export function isPollImageContentType(value: string): boolean {
  return (POLL_IMAGE_CONTENT_TYPES as readonly string[]).includes(value);
}

export function isImageQuestion(
  question: PollQuestion | PollQuestionPublic | null
): question is PollChoiceQuestion | PollChoiceQuestionPublic {
  return question?.kind === "choice" && question.display === "image";
}

export function getRoomImagePrefix(room: string): string {
  return `${POLL_IMAGE_KEY_PREFIX}/${room}/`;
}

export function getPollImageKey(room: string, questionId: string, optionId: string): string {
  return `${getRoomImagePrefix(room)}${questionId}/${optionId}`;
}

/** Splits a key from getPollImageKey back into its question and option ids. */
export function parsePollImageKey(
  room: string,
  key: string
): { questionId: string; optionId: string } | null {
  const prefix = getRoomImagePrefix(room);
  if (!key.startsWith(prefix)) return null;
  const [questionId, optionId, ...rest] = key.slice(prefix.length).split("/");
  if (!questionId || !optionId || rest.length > 0) return null;
  return { questionId, optionId };
}

/** `version` busts the immutable cache whenever an image is replaced. */
export function getPollImageUrl(
  room: string,
  questionId: string,
  optionId: string,
  version: string
): string {
  return `/api/images/${encodeURIComponent(room)}/${encodeURIComponent(questionId)}/${encodeURIComponent(optionId)}?v=${encodeURIComponent(version)}`;
}

export function getAdminPollImageEndpoint(room: string, questionId: string, optionId: string): string {
  return `/api/admin/rooms/${encodeURIComponent(room)}/images/${encodeURIComponent(questionId)}/${encodeURIComponent(optionId)}`;
}

export function isAdminPollImageUploadResponse(
  body: unknown
): body is { image: RoomOptionImages[string][string] } {
  return Boolean(body && typeof body === "object" && "image" in body);
}

export function parsePollImageDimension(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_POLL_IMAGE_DIMENSION) return null;
  return parsed;
}

export function toPollOptionImage(
  room: string,
  questionId: string,
  optionId: string,
  customMetadata: Record<string, string> | undefined
): PollOptionImage | null {
  const width = parsePollImageDimension(customMetadata?.width);
  const height = parsePollImageDimension(customMetadata?.height);
  const uploadedAt = customMetadata?.uploadedAt;
  if (width === null || height === null || !uploadedAt) return null;
  return { url: getPollImageUrl(room, questionId, optionId, uploadedAt), width, height };
}

/** Wide sets stack on phones; tall or mixed sets sit side by side. */
export function isLandscapeImageSet(images: PollOptionImage[]): boolean {
  if (images.length === 0) return false;
  return images.every((image) => image.width > image.height);
}

export async function readImageDimensions(file: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}
