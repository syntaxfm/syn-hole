import type { SyntaxSessionPublic, SyntaxSubmissionMode, SyntaxPoint, SyntaxClickPage } from "./types";
import type { PollRole } from "../types";
import { parseSyntaxPoint } from "~/syntax-game/validation";

/** Opt in with WebSocket query syntaxProtocol=1. Negotiated sockets receive both
 * legacy poll messages and SyntaxOutgoingMessage: discriminate by `type`.
 * Legacy sockets receive ONLY poll state/error messages. Roles come from authenticated connection state;
 * voterId is browser-chosen identity, not authentication or anti-impersonation. */
export type SyntaxCommand =
  | { type: "syntax:launch"; setId: string; submissionMode: SyntaxSubmissionMode }
  /** No early close. Reveal is valid only when RECEIVED at/after the deadline, not
   * merely processed after it. Abort remains an explicit non-revealing exit. */
  | { type: "syntax:open" | "syntax:reveal" | "syntax:next" | "syntax:finish" | "syntax:abort"; gameId: string; roundId: string }
  /** Both submission modes send one FINAL normalized point. Drafts stay local.
   * Extra client timing, identity, score, role and correctness fields are ignored. */
  | { type: "syntax:answer"; gameId: string; roundId: string; point: SyntaxPoint }
  | { type: "syntax:clicks"; gameId: string; roundId: string; offset: number }
  | { type: "syntax:polls" }
  | { type: "syntax:ready"; gameId: string; roundId: string; status: "ready" | "failed" };

export type SyntaxStateMessage = {
  type: "syntax:state";
  protocol: 1;
  mode: "poll" | "syntax";
  serverNow: number;
  role: PollRole;
  roundId: string | null;
  /** Prepared images are preloadable, but clients must visually hide them until
   * open. Preloading is visual preparation, NOT anti-cheat secrecy. Timings are
   * server-owned; asset failures never extend them. Abort is explicit and does
   * not reveal hidden rounds; syntax:polls requires a terminal session. */
  session: SyntaxSessionPublic | null;
  yourReceipt: SyntaxAnswerReceipt | null;
  /** Safe preview only: never targets or unrevealed explanations. Readiness is
   * advisory, per live connection, and never delays/extends a deadline. */
  host: { ready: number; failed: number; connected: number } | null;
};

export type SyntaxAnswerReceipt = {
  gameId: string;
  roundId: string;
  point: SyntaxPoint;
  receivedAt: number;
  elapsedMs: number;
};
export type SyntaxAnswerAck = {
  type: "syntax:answer-ack";
  status: "accepted" | "replayed";
  receipt: SyntaxAnswerReceipt;
};
export type SyntaxErrorCode = "invalid-payload" | "forbidden" | "inactive-mode" | "stale-round" | "not-open" | "not-joined" | "already-submitted" | "not-revealed" | "command-rejected" | "internal-error";
/** Answers always get an ack or this error on negotiated sockets. Errors never
 * include scoring/correctness/another player's receipt. Retry after an ambiguous
 * disconnect with the identical point and IDs: replay returns the ORIGINAL receipt.
 * State.yourReceipt is the reconnect fallback and may arrive before the ack.
 * Accepted means locked, NOT correct. Stale IDs never replay a past round. */
export type SyntaxErrorMessage = {
  type: "syntax:error";
  command: string;
  code: SyntaxErrorCode;
  message: string;
  gameId?: string;
  roundId?: string;
};
export type SyntaxClicksMessage = { type: "syntax:clicks"; gameId: string; roundId: string; page: SyntaxClickPage };
export type SyntaxOutgoingMessage = SyntaxStateMessage | SyntaxAnswerAck | SyntaxErrorMessage | SyntaxClicksMessage;

export class SyntaxProtocolError extends Error {
  code: SyntaxErrorCode;
  constructor(code: SyntaxErrorCode, message: string) { super(message); this.code = code; }
}

export function syntaxRoundId(gameId: string, index: number): string {
  return `${gameId}:${index}`;
}

export function parseSyntaxCommand(value: unknown): SyntaxCommand {
  if (!value || typeof value !== "object") throw new Error("Invalid syntax command.");
  const m = value as Record<string, unknown>;
  if (m.type === "syntax:polls") return { type: m.type };
  if (m.type === "syntax:launch") {
    if (typeof m.setId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(m.setId) || (m.submissionMode !== "first-click" && m.submissionMode !== "confirm")) throw new Error("Invalid launch options.");
    return { type: m.type, setId: m.setId, submissionMode: m.submissionMode };
  }
  if (typeof m.gameId !== "string" || m.gameId.length > 128 || typeof m.roundId !== "string" || m.roundId.length > 160) throw new Error("gameId and roundId are required.");
  if (m.type === "syntax:answer") return { type: m.type, gameId: m.gameId, roundId: m.roundId, point: parseSyntaxPoint(m.point) };
  if (m.type === "syntax:clicks") {
    if (!Number.isSafeInteger(m.offset) || (m.offset as number) < 0) throw new Error("Invalid click page offset.");
    return { type: m.type, gameId: m.gameId, roundId: m.roundId, offset: m.offset as number };
  }
  if (m.type === "syntax:ready" && (m.status === "ready" || m.status === "failed")) return { type: m.type, gameId: m.gameId, roundId: m.roundId, status: m.status };
  switch (m.type) {
    case "syntax:open": case "syntax:reveal":
    case "syntax:next": case "syntax:finish": case "syntax:abort":
      return { type: m.type, gameId: m.gameId, roundId: m.roundId };
    default: throw new Error("Unsupported syntax command. Early close is not allowed; wait for the deadline or abort.");
  }
}
