import test from "node:test";
import assert from "node:assert/strict";
import { SyntaxSurfaceGesture, SYNTAX_INITIAL_VIEW, SYNTAX_DRAG_THRESHOLD, SYNTAX_TAP_MAX_MS, syntaxSurfaceTransform, syntaxZoomView, syntaxKeyboardPoint } from "../src/components/syntax-image-interaction.ts";
import { syntaxClientPoint, syntaxTargetContains } from "../src/syntax-game/geometry.ts";

const box = { left: 40, top: 80, width: 400, height: 400 };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const project = (point, transform) => ({ x: transform.e + point.x * transform.a, y: transform.f + point.y * transform.d });

for (const image of [{ width: 1600, height: 900 }, { width: 900, height: 1600 }]) {
  test(`original ${image.width}x${image.height} bounds, letterbox, circles and nested targets`, () => {
    const transform = syntaxSurfaceTransform(image, box, SYNTAX_INITIAL_VIEW);
    const center = { x: 0.5, y: 0.5 };
    assert.deepEqual(syntaxClientPoint(project(center, transform), transform, box), center);
    assert.equal(syntaxClientPoint({ x: box.left + 1, y: box.top + 1 }, transform, box), null);
    const outer = { ...center, radius: 0.1 }, inner = { ...center, radius: 0.025 };
    const point = { x: 0.5, y: 0.5 + 0.05 * image.width / image.height };
    assert.equal(syntaxTargetContains(point, outer, image), true);
    assert.equal(syntaxTargetContains(point, inner, image), false);
    // Both rendered radii are measured using image width: circles, never ellipses.
    close((point.y - center.y) * transform.d, 0.05 * transform.a);
  });
  test(`transformed clicks and resize/orientation ${image.width}x${image.height}`, () => {
    const view = { zoom: 2.3, x: 0.12, y: -0.08 };
    for (const bounds of [box, { left: 0, top: 0, width: 260, height: 600 }, { left: 0, top: 0, width: 700, height: 300 }]) {
      const transform = syntaxSurfaceTransform(image, bounds, view);
      const point = { x: 0.48, y: 0.52 };
      const result = syntaxClientPoint(project(point, transform), transform, bounds);
      assert.ok(result); close(result.x, point.x); close(result.y, point.y);
      assert.equal(syntaxClientPoint({ x: bounds.left - 1, y: bounds.top }, transform, bounds), null);
    }
  });
}

test("zoom preserves anchor, clamps zoom and reset restores original bounds", () => {
  const view = { zoom: 2, x: 0.1, y: -0.2 }, anchor = { x: 0.7, y: 0.4 };
  const next = syntaxZoomView(view, 4, anchor);
  close((anchor.x - 0.5 - view.x) / view.zoom, (anchor.x - 0.5 - next.x) / next.zoom);
  close((anchor.y - 0.5 - view.y) / view.zoom, (anchor.y - 0.5 - next.y) / next.zoom);
  assert.equal(syntaxZoomView(view, 100).zoom, 8);
  assert.equal(syntaxZoomView(view, 0.1).zoom, 1);
  assert.deepEqual(SYNTAX_INITIAL_VIEW, { zoom: 1, x: 0, y: 0 });
});

test("tap tolerates small jitter but not displacement arriving only on pointerup", () => {
  const gesture = new SyntaxSurfaceGesture();
  gesture.down(1, { x: 100, y: 100 }, 0);
  assert.deepEqual(gesture.move(1, { x: 102, y: 101 }, box, SYNTAX_INITIAL_VIEW), SYNTAX_INITIAL_VIEW);
  assert.equal(gesture.up(1, { x: 102, y: 101 }, 120), true);
  gesture.down(1, { x: 100, y: 100 }, 200);
  assert.equal(gesture.up(1, { x: 100 + SYNTAX_DRAG_THRESHOLD + 1, y: 100 }, 300), false);
});

test("drag away and back can never be a first-click submission", () => {
  const gesture = new SyntaxSurfaceGesture();
  gesture.down(1, { x: 100, y: 100 }, 0);
  const view = gesture.move(1, { x: 140, y: 120 }, box, SYNTAX_INITIAL_VIEW);
  close(view.x, 0.1); close(view.y, 0.05);
  gesture.move(1, { x: 100, y: 100 }, box, view);
  assert.equal(gesture.up(1, { x: 100, y: 100 }, 200), false);
});

test("pinch zoom plus midpoint pan; neither finger may submit, even after one lifts", () => {
  const gesture = new SyntaxSurfaceGesture();
  gesture.down(1, { x: 140, y: 280 }, 0);
  gesture.down(2, { x: 340, y: 280 }, 10);
  const view = gesture.move(2, { x: 440, y: 280 }, box, SYNTAX_INITIAL_VIEW);
  close(view.zoom, 1.5); close(view.x, 0.125);
  assert.equal(gesture.up(2, { x: 440, y: 280 }, 100), false);
  assert.equal(gesture.up(1, { x: 140, y: 280 }, 120), false);
  gesture.down(3, { x: 200, y: 200 }, 200);
  assert.equal(gesture.up(3, { x: 200, y: 200 }, 300), true);
});

test("stationary two-finger tap cannot submit", () => {
  const gesture = new SyntaxSurfaceGesture();
  gesture.down(1, { x: 100, y: 100 }, 0);
  gesture.down(2, { x: 110, y: 110 }, 1);
  assert.equal(gesture.up(1, { x: 100, y: 100 }, 100), false);
  assert.equal(gesture.up(2, { x: 110, y: 110 }, 110), false);
});

for (const cause of ["scroll", "wheel", "control", "outside start", "blur"]) {
  test(`${cause} invalidates a pending first-click gesture`, () => {
    const gesture = new SyntaxSurfaceGesture();
    gesture.down(1, { x: 100, y: 100 }, 0);
    gesture.invalidate();
    assert.equal(gesture.up(1, { x: 100, y: 100 }, 100), false);
  });
}

test("pointer cancellation, lost capture and resize clear never submit", () => {
  for (const operation of ["cancel", "clear"]) {
    const gesture = new SyntaxSurfaceGesture();
    gesture.down(1, { x: 100, y: 100 }, 0);
    gesture[operation](1);
    assert.equal(gesture.up(1, { x: 100, y: 100 }, 100), false);
  }
  const gesture = new SyntaxSurfaceGesture();
  gesture.down(1, { x: 100, y: 100 }, 0);
  gesture.down(2, { x: 110, y: 110 }, 1);
  gesture.cancel(2);
  assert.equal(gesture.up(1, { x: 100, y: 100 }, 100), false);
});

test("long press and unknown pointerup cannot submit", () => {
  const gesture = new SyntaxSurfaceGesture();
  assert.equal(gesture.up(99, { x: 100, y: 100 }, 0), false);
  gesture.down(1, { x: 100, y: 100 }, 0);
  assert.equal(gesture.up(1, { x: 100, y: 100 }, SYNTAX_TAP_MAX_MS + 1), false);
});

test("keyboard movement is aspect-correct, fine-grained and bounded; confirmation is not movement", () => {
  const center = { x: 0.5, y: 0.5 };
  assert.deepEqual(syntaxKeyboardPoint(center, "ArrowRight", 1600, 800), { x: 0.51, y: 0.5 });
  assert.deepEqual(syntaxKeyboardPoint(center, "ArrowDown", 1600, 800), { x: 0.5, y: 0.52 });
  close(syntaxKeyboardPoint(center, "ArrowLeft", 800, 1600, true).x, 0.499);
  assert.deepEqual(syntaxKeyboardPoint({ x: 0, y: 1 }, "ArrowLeft", 800, 1600), { x: 0, y: 1 });
  assert.deepEqual(syntaxKeyboardPoint({ x: 1, y: 1 }, "ArrowDown", 800, 1600), { x: 1, y: 1 });
  assert.equal(syntaxKeyboardPoint(center, "Enter", 800, 1600), null);
  assert.equal(syntaxKeyboardPoint(center, "Tab", 800, 1600), null);
});
