import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import ts from "typescript";
import { createSyntaxDraft } from "../src/utils/syntax-editor.ts";

// Seed authoring/host hooks to inspect their real JSX in loaded states.
// Image-surface hooks and implementation remain untouched.
const hooks = `data:text/javascript,${encodeURIComponent(`
  export const useEffect = () => {};
  export const useRef = current => ({ current });
  export const useState = initial => [globalThis.__syntaxAdminStates.shift() ?? initial, value => globalThis.__syntaxAdminWrites?.push(value)];
`)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const base = specifier.startsWith("~/") ? new URL(`../src/${specifier.slice(2)}`, import.meta.url)
      : specifier.startsWith(".") && context.parentURL?.startsWith("file:") ? new URL(specifier, context.parentURL) : null;
    if (base && !/\.[a-z]+$/i.test(base.pathname)) {
      for (const extension of [".ts", ".tsx"]) {
        const url = new URL(`${base.href}${extension}`);
        if (existsSync(url)) return nextResolve(url.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    let source = readFileSync(new URL(url), "utf8");
    if (/syntax-(entry-editor|library|set-editor|set-list|host)\.tsx$/.test(url)) source = source.replace('from "react"', `from ${JSON.stringify(hooks)}`);
    return { format: "module", shortCircuit: true, source: ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText };
  },
});
const { SyntaxEntryEditor } = await import("../src/components/syntax-entry-editor.tsx");
const { SyntaxSetEditor } = await import("../src/components/syntax-set-editor.tsx");
const { SyntaxLibrary } = await import("../src/components/syntax-library.tsx");
const { SyntaxSetList } = await import("../src/components/syntax-set-list.tsx");
const { SyntaxHost } = await import("../src/components/syntax-host.tsx");
const { SyntaxImageSurface } = await import("../src/components/syntax-image-surface.tsx");
const entry = { ...createSyntaxDraft("one"), title: "CSS typo", language: "CSS", imageRevisionId: "revision", image: { url: "/image", width: 200, height: 100, alt: "Code" }, targets: [{ x: 0.5, y: 0.5, radius: 0.05 }] };
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return node && typeof node === "object" && node.props ? [node, ...nodes(node.props.children)] : [];
}
function editor(record = entry, testing = false, point = null) {
  globalThis.__syntaxAdminStates = ["key", record, "saved", null, false, 0, null, null, testing, point];
  return nodes(SyntaxEntryEditor({ entryId: "one" }));
}
test("screenshot workspace has one canvas and keeps optional metadata collapsed", () => {
  const tree = editor();
  assert.equal(tree.filter(node => node.type === SyntaxImageSurface).length, 1);
  assert.equal(tree.find(node => node.type === SyntaxImageSurface).props.mode, "edit");
  const details = tree.find(node => node.type === "details");
  assert.equal(details.props.open, undefined);
  assert.ok(nodes(details).some(node => node.type === "textarea"));
  assert.equal(tree.filter(node => node.type === "input" && node.props.type === "number").length, 0);
  const toggle = tree.find(node => node.props.role === "switch");
  assert.equal(toggle.props.children, "Use in games");
  assert.equal(toggle.props.disabled, false);
  assert.equal(editor({ ...entry, targets: [] }).find(node => node.props.role === "switch").props.disabled, true);
  assert.equal(editor({ ...entry, status: "reviewed" }).find(node => node.props.role === "switch").props["aria-checked"], true);
});
test("test mode is repeatable on one play canvas with concise hit/miss feedback", () => {
  for (const [point, result] of [[{ x: 0.5, y: 0.5 }, "Hit"], [{ x: 0, y: 0 }, "Miss"]]) {
    const tree = editor(entry, true, point);
    const surfaces = tree.filter(node => node.type === SyntaxImageSurface);
    assert.equal(surfaces.length, 1);
    assert.equal(surfaces[0].props.mode, "play");
    assert.equal(surfaces[0].props.submittedPoint, undefined);
    assert.ok(tree.some(node => node.props.role === "status" && node.props.children === result));
  }
});
test("empty screenshot editor starts with a dropzone instead of an image canvas", () => {
  const tree = editor(createSyntaxDraft("empty"));
  assert.equal(tree.filter(node => node.type === SyntaxImageSurface).length, 0);
  assert.ok(tree.some(node => node.props.className === "syntax-dropzone" && node.props.onDrop));
});
test("set editor places chosen rounds before a searchable add-by-thumbnail library", () => {
  const draft = { id: "set", title: "CSS set", defaultSeconds: "30", submissionMode: "confirm", rounds: [{ entryId: "one", seconds: "" }] };
  const available = { ...entry, id: "two", status: "reviewed" };
  globalThis.__syntaxAdminStates = ["key", draft, [entry, available], null, "saved", false, "", null, false];
  const tree = nodes(SyntaxSetEditor({ setId: "set" }));
  const chosen = tree.find(node => node.props.className?.includes("syntax-set-chosen"));
  const library = tree.find(node => node.type === "aside");
  assert.ok(tree.indexOf(chosen) < tree.indexOf(library));
  assert.ok(nodes(library).some(node => node.type === "input" && node.props.type === "search"));
  assert.equal(nodes(library).filter(node => node.type === "button" && node.props["aria-label"] === "Add CSS typo").length, 1);
  assert.equal(tree.find(node => node.props["aria-label"] === "Round 1 seconds (optional)").props.placeholder, "30");
});
test("library and set cards use thumbnails, ready/draft chips and collapsed issues", () => {
  globalThis.__syntaxAdminStates = ["key", [entry], null, false, 0, ""];
  const library = nodes(SyntaxLibrary());
  assert.ok(library.some(node => node.type === "img"));
  assert.ok(library.some(node => node.props.className === "syntax-status is-draft"));
  const set = { id: "set", title: "CSS set", defaultDurationMs: 30000, submissionMode: "first-click", rounds: [{ entryId: "one" }] };
  globalThis.__syntaxAdminStates = ["key", [set], [entry], null, 0, false];
  const sets = nodes(SyntaxSetList());
  assert.ok(sets.some(node => node.type === "img"));
  assert.equal(sets.find(node => node.type === "details").props.open, undefined);
});

test("feature navigation and creation use the requested names", () => {
  const text = node => typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node?.props ? text(node.props.children) : "";
  globalThis.__syntaxAdminStates = ["key", [], null, false, 0, ""];
  const library = nodes(SyntaxLibrary());
  assert.equal(library.find(node => node.type === "h1").props.children, "Spot the Syntax Error");
  assert.equal(library.filter(node => node.type === "button" && text(node).trim() === "New code snippet image").length, 2);
  assert.ok(editor().some(node => node.type === "a" && node.props.href === "/admin/syntax/" && text(node) === "Spot the Syntax Error"));
});

test("host uses the selected set's submission default unless explicitly overridden", () => {
  const savedSet = { id: "confirm-set", title: "Confirm game", submissionMode: "confirm", defaultDurationMs: 30000, roundCount: 2 };
  for (const override of [null, "first-click"]) {
    globalThis.__syntaxAdminStates = [[savedSet], savedSet.id, override];
    const commands = [];
    const tree = nodes(SyntaxHost({ room: "main", hostKey: "key", state: { mode: "poll", session: null }, connected: true, send: command => commands.push(command) }));
    const expected = override ?? savedSet.submissionMode;
    assert.equal(tree.filter(node => node.type === "select")[1].props.value, expected);
    const launch = tree.find(node => node.type === "button" && node.props.children === "Prepare game");
    assert.equal(launch.props.disabled, false);
    launch.props.onClick();
    assert.deepEqual(commands, [{ type: "syntax:launch", setId: savedSet.id, submissionMode: expected }]);
    globalThis.__syntaxAdminWrites = [];
    tree.filter(node => node.type === "select")[0].props.onChange({ target: { value: "another-set" } });
    assert.deepEqual(globalThis.__syntaxAdminWrites, ["another-set", null]);
    delete globalThis.__syntaxAdminWrites;
  }
});
