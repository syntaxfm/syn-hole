import type { SyntaxImage, SyntaxPoint, SyntaxTarget } from "~/syntax-game/types";
import { parseSyntaxPoint, SYNTAX_MAX_RADIUS } from "~/syntax-game/validation";

export type SyntaxRect = Readonly<{ left: number; top: number; width: number; height: number }>;
/** Maps normalized original-image coordinates to viewport/client coordinates.
 * Includes object-fit offsets, pan/zoom and CSS transforms; rotation/skew allowed.
 * Callers obtain the CONTENT quad, not the outer element's axis-aligned DOMRect.
 */
export type SyntaxImageTransform = Readonly<{
  a: number; b: number; c: number; d: number; e: number; f: number;
}>;

function validSize(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

/** Centered object-fit: contain, without rotation. Letterbox is not clickable. */
export function syntaxContainTransform(image: Pick<SyntaxImage, "width" | "height">, box: SyntaxRect): SyntaxImageTransform {
  if (!validSize(image.width, image.height) || !validSize(box.width, box.height) ||
      !Number.isFinite(box.left) || !Number.isFinite(box.top)) {
    throw new Error("Image and display bounds must have finite positive dimensions.");
  }
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { a: width, b: 0, c: 0, d: height, e: box.left + (box.width - width) / 2, f: box.top + (box.height - height) / 2 };
}

/** Returns null outside the actual image or clipping viewport, never clamps.
 * Supply clip for a panned/zoomed image cropped by an overflow-hidden surface.
 * For perspective transforms the UI must first undo perspective; affine only here.
 */
export function syntaxClientPoint(
  client: SyntaxPoint,
  transform: SyntaxImageTransform,
  clip?: SyntaxRect
): SyntaxPoint | null {
  if (!Number.isFinite(client.x) || !Number.isFinite(client.y)) return null;
  if (!Object.values(transform).every(Number.isFinite)) return null;
  if (clip && (!validSize(clip.width, clip.height) || !Number.isFinite(clip.left) || !Number.isFinite(clip.top) ||
    client.x < clip.left || client.x > clip.left + clip.width || client.y < clip.top || client.y > clip.top + clip.height)) return null;
  const { a, b, c, d, e, f } = transform;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant === 0) return null;
  const x = (d * (client.x - e) - c * (client.y - f)) / determinant;
  const y = (-b * (client.x - e) + a * (client.y - f)) / determinant;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/** True Euclidean circle in original pixels. Boundary included; any target wins. */
export function syntaxTargetContains(point: SyntaxPoint, target: SyntaxTarget, image: Pick<SyntaxImage, "width" | "height">): boolean {
  parseSyntaxPoint(point);
  parseSyntaxPoint(target, "Target");
  if (!validSize(image.width, image.height) || !Number.isFinite(target.radius) || target.radius <= 0 || target.radius > SYNTAX_MAX_RADIUS) {
    throw new Error("Target radius and image dimensions are invalid.");
  }
  const dx = point.x - target.x;
  const dy = (point.y - target.y) * image.height / image.width;
  // Permit only arithmetic roundoff at a circle boundary, not a gameplay margin.
  const distance = Math.hypot(dx, dy);
  const roundoff = Number.EPSILON * Math.max(distance, target.radius) * 4;
  return distance <= target.radius + roundoff;
}

export function syntaxIsHit(point: SyntaxPoint, targets: readonly SyntaxTarget[], image: Pick<SyntaxImage, "width" | "height">): boolean {
  parseSyntaxPoint(point);
  return targets.some((target) => syntaxTargetContains(point, target, image));
}
