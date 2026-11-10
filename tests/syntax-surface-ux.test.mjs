import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import ts from "typescript";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const base = specifier.startsWith("~/") ? new URL(`../src/${specifier.slice(2)}`, import.meta.url)
      : specifier.startsWith(".") && context.parentURL?.startsWith("file:") ? new URL(specifier, context.parentURL) : null;
    if (base && !/\.[a-z]+$/i.test(base.pathname)) {
      for (const extension of [".ts", ".tsx"]) if (existsSync(new URL(`${base.href}${extension}`))) return nextResolve(`${base.href}${extension}`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    return { format: "module", source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText, shortCircuit: true };
  },
});

const { SyntaxImageSurface } = await import("../src/components/syntax-image-surface.tsx");
const image = { url: "/test.png", width: 800, height: 400, alt: "Code" };
const noop = () => {};
const render = props => renderToString(createElement(SyntaxImageSurface, { image, ...props }));

test("first-click play has no coordinate fields, confirm action or coordinate readout", () => {
  const html = render({ mode: "play", submissionMode: "first-click", onDraftChange: noop, onSubmit: noop, submittedPoint: { x: .2, y: .5 } });
  assert.doesNotMatch(html, /<input|Horizontal|Vertical|submitted at|Confirm answer/);
  assert.match(html, /aria-label="Zoom in"/);
  assert.match(html, /class="syntax-sr-only"/);
});

test("confirm mode keeps one explicit action without position inputs", () => {
  const html = render({ mode: "play", submissionMode: "confirm", onDraftChange: noop, onSubmit: noop });
  assert.match(html, /Confirm answer/);
  assert.doesNotMatch(html, /<input|Horizontal|Vertical/);
});

test("visual editing exposes place/move, numbered targets and a size slider", () => {
  const html = render({ mode: "edit", targets: [{ x: .3, y: .4, radius: .025 }], selectedTargetIndex: 0, onSelectedTargetChange: noop, onTargetsChange: noop });
  assert.match(html, /Place target/);
  assert.match(html, /aria-label="Select target 1"/);
  assert.match(html, /type="range" aria-label="Target size"/);
  assert.doesNotMatch(html, /type="number"|Horizontal|Vertical|Add target/);
});

test("empty editing stage starts in placement mode without prerequisite controls", () => {
  const html = render({ mode: "edit", targets: [], selectedTargetIndex: null, onSelectedTargetChange: noop, onTargetsChange: noop });
  assert.match(html, /aria-pressed="true"[^>]*>.*?Place target/s);
  assert.match(html, /Click the error to place a target/);
  assert.doesNotMatch(html, /<select|type="number"/);
});
