import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import ts from "typescript";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// Node 24 strips .ts but not JSX. Use the existing compiler only for this file.
let runtimeNumberFlowImports = 0;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@number-flow/react") {
      runtimeNumberFlowImports += 1;
      throw new Error("NumberFlow must not be imported during SSR");
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/components/flow-number.tsx")) {
      const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { FlowNumber } = await import("../src/components/flow-number.tsx");
const render = props => renderToString(createElement(FlowNumber, props));

test("SSR renders a formatted accessible fallback without importing the DOM-dependent package", () => {
  const html = render({ value: 1234.5, locales: "en-US", format: { minimumFractionDigits: 2 }, prefix: "$", suffix: " total" });
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="\$1,234\.50 total"/);
  assert.match(html, />\$1,234\.50 total<\/span>/);
  assert.equal(runtimeNumberFlowImports, 0);
});

test("fallback preserves countdown padding, locale and grouping options", () => {
  assert.match(render({ value: 5, locales: "en-US", format: { useGrouping: false, minimumIntegerDigits: 2 } }), />05<\/span>/);
  assert.match(render({ value: 1234, locales: "en-US", format: { useGrouping: false, maximumFractionDigits: 0 } }), />1234<\/span>/);
  assert.match(render({ value: 1234.5, locales: "de-DE", format: { minimumFractionDigits: 2 } }), />1\.234,50<\/span>/);
});

test("fallback keeps styling, HTML and accessibility attributes but omits animation-only props", () => {
  const html = render({ value: 7, id: "counter", className: "countdown", title: "Remaining", "aria-label": "Seven left", "aria-live": "polite", "data-round": "2", style: { color: "red", lineHeight: 2 }, animated: false, trend: -1, isolate: true, willChange: true, digits: { 0: { max: 5 } } });
  for (const attribute of ['id="counter"', 'class="countdown"', 'title="Remaining"', 'aria-label="Seven left"', 'aria-live="polite"', 'data-round="2"', "display:inline-block", "font-variant-numeric:tabular-nums", "color:red", "line-height:2"]) assert.ok(html.includes(attribute), attribute);
  assert.doesNotMatch(html, /animated=|trend=|digits=|isolate=|willChange=/);
});

test("numeric strings keep their precision and fallback content is escaped", () => {
  assert.match(render({ value: "9007199254740993", locales: "en-US", format: { useGrouping: false } }), />9007199254740993<\/span>/);
  const html = render({ value: 1, prefix: "<script>", suffix: "&" });
  assert.match(html, /&lt;script&gt;1&amp;/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(runtimeNumberFlowImports, 0);
});
