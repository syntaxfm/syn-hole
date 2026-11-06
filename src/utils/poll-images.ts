import type {
  AdminPollImageOption,
  PollChoiceQuestion,
  PollChoiceQuestionPublic,
  PollOptionImage,
  PollQuestion,
  PollQuestionPublic,
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

const POLL_IMAGE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function isPollImageId(value: string): boolean {
  return POLL_IMAGE_ID_PATTERN.test(value);
}

export function isPollImageContentType(value: string): boolean {
  return (POLL_IMAGE_CONTENT_TYPES as readonly string[]).includes(value);
}

export function isImageQuestion(
  question: PollQuestion | PollQuestionPublic | null
): question is PollChoiceQuestion | PollChoiceQuestionPublic {
  return question?.kind === "choice" && question.display === "image";
}

export function getPollImageKey(questionId: string, optionId: string): string {
  return `${POLL_IMAGE_KEY_PREFIX}/${questionId}/${optionId}`;
}

export function getAdminPollImageEndpoint(questionId: string, optionId: string): string {
  return `/api/admin/images/${encodeURIComponent(questionId)}/${encodeURIComponent(optionId)}`;
}

export function isAdminPollImageUploadResponse(
  body: unknown
): body is { image: AdminPollImageOption["image"] } {
  return Boolean(body && typeof body === "object" && "image" in body);
}

/** `version` busts the immutable cache whenever an image is replaced. */
export function getPollImageUrl(questionId: string, optionId: string, version: string): string {
  return `/api/images/${encodeURIComponent(questionId)}/${encodeURIComponent(optionId)}?v=${encodeURIComponent(version)}`;
}

export function parsePollImageDimension(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_POLL_IMAGE_DIMENSION) return null;
  return parsed;
}

export function toPollOptionImage(
  questionId: string,
  optionId: string,
  customMetadata: Record<string, string> | undefined
): PollOptionImage | null {
  const width = parsePollImageDimension(customMetadata?.width);
  const height = parsePollImageDimension(customMetadata?.height);
  const uploadedAt = customMetadata?.uploadedAt;
  if (width === null || height === null || !uploadedAt) return null;
  return { url: getPollImageUrl(questionId, optionId, uploadedAt), width, height };
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
