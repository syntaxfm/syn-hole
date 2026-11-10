import type { SyntaxSessionPublic } from "~/syntax-game/types";

export type SyntaxHostSet = { id: string; title: string; defaultDurationMs: number; submissionMode: "first-click" | "confirm"; roundCount: number };

/** The protected host endpoint deliberately omits targets and per-round metadata. */
export function parseSyntaxHostSets(value: unknown): SyntaxHostSet[] {
  if (!Array.isArray(value)) throw new Error("The saved-set response was invalid. Reload the sets.");
  return value.map((item) => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.id)
      || typeof item.title !== "string" || !Number.isFinite(item.defaultDurationMs) || item.defaultDurationMs <= 0
      || !Number.isSafeInteger(item.roundCount) || item.roundCount <= 0 || !["first-click", "confirm"].includes(item.submissionMode)) {
      throw new Error("The saved-set response was invalid. Reload the sets.");
    }
    return { id: item.id, title: item.title, defaultDurationMs: item.defaultDurationMs, submissionMode: item.submissionMode, roundCount: item.roundCount };
  });
}

/** Anchor to server time and elapsed MONOTONIC time, never the browser wall clock.
 * A fresh socket state resynchronizes the sample after reconnect/hibernation. */
export function syntaxHostNow(serverNow: number, sampledAt: number, monotonicNow: number): number {
  return serverNow + Math.max(0, monotonicNow - sampledAt);
}

export function syntaxHostControls(session: SyntaxSessionPublic | null, now: number) {
  const terminal = session?.phase === "finished" || session?.phase === "aborted";
  const expired = !!session?.timing && now >= session.timing.deadlineAt;
  return {
    launch: !session || terminal,
    start: session?.phase === "prepared",
    reveal: session?.phase === "closed" || (session?.phase === "open" && expired),
    next: session?.phase === "revealed" && session.currentRound.roundIndex + 1 < session.totalRounds,
    finish: session?.phase === "revealed" && session.currentRound.roundIndex + 1 === session.totalRounds,
    abort: !!session && !terminal,
    polls: !!terminal,
    remainingMs: session?.phase === "open" && session.timing ? Math.max(0, session.timing.deadlineAt - now) : 0,
  };
}
