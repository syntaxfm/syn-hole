import { syntaxContainTransform, type SyntaxRect } from "~/syntax-game/geometry";
import type { SyntaxImage, SyntaxPoint } from "~/syntax-game/types";

/** Pan is a fraction of the viewport so it survives resize/orientation changes. */
export type SyntaxView = Readonly<{ zoom: number; x: number; y: number }>;
export const SYNTAX_INITIAL_VIEW: SyntaxView = { zoom: 1, x: 0, y: 0 };
export const SYNTAX_DRAG_THRESHOLD = 6;
export const SYNTAX_TAP_MAX_MS = 500;
export const SYNTAX_MAX_ZOOM = 8;

export function syntaxSurfaceTransform(image: Pick<SyntaxImage, "width" | "height">, box: SyntaxRect, view: SyntaxView) {
  const base = syntaxContainTransform(image, box);
  return {
    ...base, a: base.a * view.zoom, d: base.d * view.zoom,
    e: box.left + box.width / 2 + (base.e - box.left - box.width / 2) * view.zoom + view.x * box.width,
    f: box.top + box.height / 2 + (base.f - box.top - box.height / 2) * view.zoom + view.y * box.height,
  };
}

/** Zoom around a viewport-relative anchor, not around an arbitrary image corner. */
export function syntaxZoomView(view: SyntaxView, zoom: number, anchor: SyntaxPoint = { x: 0.5, y: 0.5 }): SyntaxView {
  zoom = Math.max(1, Math.min(SYNTAX_MAX_ZOOM, zoom));
  const ratio = zoom / view.zoom;
  return { zoom, x: anchor.x - 0.5 - (anchor.x - 0.5 - view.x) * ratio,
    y: anchor.y - 0.5 - (anchor.y - 0.5 - view.y) * ratio };
}

export function syntaxKeyboardPoint(point: SyntaxPoint, key: string, width: number, height: number, fine = false): SyntaxPoint | null {
  const step = fine ? 0.001 : 0.01;
  const delta: Record<string, SyntaxPoint> = {
    ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 },
    ArrowUp: { x: 0, y: -step * width / height }, ArrowDown: { x: 0, y: step * width / height },
  };
  if (!delta[key]) return null;
  return { x: Math.max(0, Math.min(1, point.x + delta[key].x)), y: Math.max(0, Math.min(1, point.y + delta[key].y)) };
}

type Contact = { start: SyntaxPoint; point: SyntaxPoint; time: number };
/** One gesture stays disqualified until EVERY contact ends, including after pinch. */
export class SyntaxSurfaceGesture {
  private contacts = new Map<number, Contact>();
  private blocked = false;

  invalidate() { if (this.contacts.size) this.blocked = true; }
  clear() { this.contacts.clear(); this.blocked = false; }

  down(id: number, point: SyntaxPoint, time: number) {
    if (!this.contacts.size) this.blocked = false;
    this.contacts.set(id, { start: point, point, time });
    if (this.contacts.size > 1) this.blocked = true;
  }

  move(id: number, point: SyntaxPoint, box: SyntaxRect, view: SyntaxView): SyntaxView {
    const contact = this.contacts.get(id);
    if (!contact) return view;
    const before = [...this.contacts.values()].map((c) => c.point);
    const wasBlocked = this.blocked;
    contact.point = point;
    if (Math.hypot(point.x - contact.start.x, point.y - contact.start.y) > SYNTAX_DRAG_THRESHOLD) this.blocked = true;
    const after = [...this.contacts.values()].map((c) => c.point);
    if (before.length >= 2) {
      const midpoint = (points: SyntaxPoint[]) => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
      const oldCenter = midpoint(before), center = midpoint(after);
      const distance = (points: SyntaxPoint[]) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const zoom = distance(before) > 0 ? view.zoom * distance(after) / distance(before) : view.zoom;
      const next = syntaxZoomView(view, zoom, { x: (oldCenter.x - box.left) / box.width, y: (oldCenter.y - box.top) / box.height });
      return { ...next, x: next.x + (center.x - oldCenter.x) / box.width, y: next.y + (center.y - oldCenter.y) / box.height };
    }
    if (!this.blocked) return view;
    // Include the threshold-crossing displacement once, without tap jitter.
    const origin = wasBlocked ? before[0] : contact.start;
    return { ...view, x: view.x + (point.x - origin.x) / box.width, y: view.y + (point.y - origin.y) / box.height };
  }

  up(id: number, point: SyntaxPoint, time: number): boolean {
    const contact = this.contacts.get(id);
    const tap = !!contact && !this.blocked && this.contacts.size === 1 &&
      time - contact.time <= SYNTAX_TAP_MAX_MS &&
      Math.hypot(point.x - contact.start.x, point.y - contact.start.y) <= SYNTAX_DRAG_THRESHOLD;
    this.contacts.delete(id);
    if (!this.contacts.size) this.blocked = false;
    return tap;
  }
  cancel(id: number) { this.invalidate(); this.contacts.delete(id); }
}
