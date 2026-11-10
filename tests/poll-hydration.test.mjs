import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import ts from "typescript";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const base = specifier.startsWith("~/")
      ? new URL(`../src/${specifier.slice(2)}`, import.meta.url)
      : specifier.startsWith(".") && context.parentURL?.startsWith("file:")
        ? new URL(specifier, context.parentURL) : null;
    if (base && !/\.[a-z]+$/i.test(base.pathname)) {
      for (const extension of [".ts", ".tsx"]) {
        const url = new URL(`${base.href}${extension}`);
        if (existsSync(url)) return nextResolve(url.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { PollPage } = await import("../src/components/poll.tsx");

for (const view of ["host", "audience", "projector"]) {
  test(`${view} initial markup is unchanged by stored browser identity and URL credentials`, () => {
    const props = { view, room: "hydration-check" };
    const server = renderToString(createElement(PollPage, props));
    const values = new Map([
      ["syntax-live-host-key", "stored-host-secret"],
      ["syntax-live-audience-name", "Returning player"],
      ["syntax-live-poll-voter-id", "returning-voter"],
      ["syntax-live-play-mode:hydration-check", "online"],
    ]);
    globalThis.window = {
      location: { origin: "http://localhost:5173", host: "localhost:5173", search: "?hostKey=url-host-secret" },
      localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    };
    try {
      const firstClient = renderToString(createElement(PollPage, props));
      assert.equal(firstClient, server);
      assert.doesNotMatch(firstClient, /stored-host-secret|url-host-secret|Returning player/);
    } finally {
      delete globalThis.window;
    }
  });
}
