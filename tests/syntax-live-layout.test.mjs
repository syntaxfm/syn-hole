import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
    if (url.endsWith(".tsx")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});

const { SyntaxPlayer } = await import("../src/components/syntax-player.tsx");
const { SyntaxHost } = await import("../src/components/syntax-host.tsx");
const { SyntaxStandings } = await import("../src/components/syntax-standings.tsx");
const row = { playerId: "p", name: "Ada", rank: 3, points: 800, correct: 2, playMode: null };
const session = {
  id: "game", title: "Syntax", phase: "prepared", submissionMode: "confirm", totalRounds: 2,
  totalResponses: 0, participants: 4, revealedRounds: 0,
  currentRound: { roundIndex: 0, title: "Round title", durationMs: 15000, image: { url: "/private-image.png", alt: "Code", width: 1600, height: 900 } },
  standings: [{ playMode: null, total: 1, standings: [row] }],
};
const state = (overrides = {}) => ({ mode: "syntax", serverNow: 1000, roundId: "game:0", session: { ...session, ...overrides } });
const player = (overrides, view = "audience") => renderToStaticMarkup(createElement(SyntaxPlayer, { state: state(overrides), view, connected: true, send() {}, lastMessage: null }));

test("prepared player reserves image space without exposing an image and uses one status slot", () => {
  const html = player({});
  assert.match(html, /syntax-game is-audience/);
  assert.match(html, /syntax-phase-state/);
  assert.doesNotMatch(html, /aspect-ratio:/);
  assert.match(html, /lucide-crosshair/);
  assert.doesNotMatch(html, /<img|private-image|server clock|protocol|coordinate/i);
  assert.equal((html.match(/role="status"/g) ?? []).length, 1);
  assert.ok(html.indexOf("syntax-game-stage") < html.indexOf("syntax-game-rail"));
});

test("open countdown is reserved chrome and becomes urgent at five seconds", () => {
  const html = player({ phase: "open", timing: { openedAt: 1000, deadlineAt: 6000 } }, "projector");
  assert.match(html, /syntax-game is-projector/);
  assert.match(html, /class="syntax-countdown" data-urgent="true" role="timer"/);
  assert.ok(html.indexOf('role="timer"') < html.indexOf("syntax-game-workspace"));
});

test("prior standings remain closed during open; final standings replace image", () => {
  const open = player({ phase: "open", revealedRounds: 1, timing: { openedAt: 1000, deadlineAt: 16000 } });
  assert.match(open, /<details class="syntax-previous-standings"><summary>Previous standings/);
  assert.doesNotMatch(open, /<details[^>]* open/);
  const final = player({ phase: "finished", revealedRounds: 2 });
  assert.match(final, /Final standings/);
  assert.doesNotMatch(final, /<img|syntax-countdown|syntax-game-rail/);
});

test("reveal removes expired countdown chrome and reports the revealed state", () => {
  const html = player({ phase: "revealed", reveal: { roundIndex: 0, targets: [], explanation: "", yourResult: null }, timing: { openedAt: 0, deadlineAt: 1000 } });
  assert.doesNotMatch(html, /syntax-countdown|role="timer"/);
  assert.match(html, /Answers revealed/);
  assert.doesNotMatch(html, /data-round-feedback|is-answer-locked|is-awaiting-reveal/);
});

test("server-accepted answer has a prominent locked state without implying correctness", () => {
  const html = player({ phase: "open", timing: { openedAt: 1000, deadlineAt: 16000 }, yourSubmission: { x: .4, y: .5 } });
  assert.match(html, /data-round-feedback="locked" role="status"/);
  assert.match(html, /Answer locked/);
  assert.match(html, /Waiting for answer reveal/);
  assert.match(html, /syntax-game-stage is-answer-locked/);
  assert.doesNotMatch(html, /Correct|data-round-feedback="closed"/);
  const unaccepted = player({ phase: "open", timing: { openedAt: 1000, deadlineAt: 16000 } });
  assert.doesNotMatch(unaccepted, /data-round-feedback="locked"|is-answer-locked/);
});

test("expired round replaces zero timer with waiting-for-host state and keeps receipt confirmation", () => {
  for (const phase of ["open", "closed"]) {
    const html = player({ phase, timing: { openedAt: 0, deadlineAt: 1000 }, yourSubmission: { x: .4, y: .5 } });
    assert.match(html, /Time’s up/);
    assert.match(html, /data-round-feedback="closed"/);
    assert.match(html, /Waiting for the host to reveal/);
    assert.match(html, /Your answer is locked/);
    assert.match(html, /syntax-game-stage is-awaiting-reveal/);
    assert.doesNotMatch(html, /syntax-countdown|role="timer"/);
  }
});

test("unanswered players and projector see round closure, never a fabricated lock", () => {
  for (const view of ["audience", "projector"]) {
    const html = player({ phase: "closed", timing: { openedAt: 0, deadlineAt: 1000 } }, view);
    assert.match(html, /Answers closed/);
    assert.match(html, /Waiting for the host to reveal/);
    assert.doesNotMatch(html, /Your answer is locked|data-round-feedback="locked"/);
  }
});

test("compact standings preserve server ranks, column headers and own off-list rank", () => {
  const html = renderToStaticMarkup(createElement(SyntaxStandings, {
    standings: session.standings, yourStanding: { ...row, playerId: "you", rank: 9, points: 200, correct: 1 },
  }));
  assert.match(html, /<th scope="col">Points<\/th>/);
  assert.match(html, /<td>#3<\/td><th scope="row">Ada/);
  assert.match(html, /<td>#9<\/td><th scope="row">You/);
  assert.doesNotMatch(html, /<h4>|800 points|2 correct/);
});

test("host stage precedes controls; abort is in overflow, not primary actions", () => {
  const html = renderToStaticMarkup(createElement(SyntaxHost, { room: "main", hostKey: "secret", state: state(), connected: true, send() {} }));
  assert.ok(html.indexOf("syntax-game-stage") < html.indexOf("syntax-game-rail"));
  assert.match(html, /Start round/);
  assert.match(html, /<details class="syntax-host-overflow"><summary>More<\/summary><button[^>]*>End game/);
  assert.doesNotMatch(html, /syntaxProtocol|advisory|anti-cheat|safe screenshot/i);
});
