import type { SyntaxAnswerReceipt, SyntaxOutgoingMessage } from "~/syntax-game/protocol";
import type { SyntaxClickPage, SyntaxPoint, SyntaxSessionPublic } from "~/syntax-game/types";

export type SyntaxClockAnchor = { serverNow: number; wallNow: number; monotonicNow: number };
/** A backwards wall-clock adjustment cannot extend a round. A forwards jump
 * conservatively freezes input; only the server can accept an answer. */
export function syntaxEstimatedNow(anchor: SyntaxClockAnchor, wallNow: number, monotonicNow: number): number {
  return anchor.serverNow + Math.max(0, wallNow - anchor.wallNow, monotonicNow - anchor.monotonicNow);
}

export function syntaxRemainingMs(session: SyntaxSessionPublic, serverNow: number): number {
  if (session.phase !== "open" || !session.timing) return 0;
  return Math.max(0, session.timing.deadlineAt - serverNow);
}

export function syntaxMatchesRound(value: { gameId?: string; roundId?: string }, gameId: string, roundId: string): boolean {
  return value.gameId === gameId && value.roundId === roundId;
}

export type SyntaxAnswerLocal = {
  draft: SyntaxPoint | null;
  attempted: SyntaxPoint | null;
  receipt: SyntaxAnswerReceipt | null;
  status: "draft" | "pending" | "uncertain" | "accepted" | "rejected";
  error: string | null;
};
export const SYNTAX_EMPTY_ANSWER: SyntaxAnswerLocal = { draft: null, attempted: null, receipt: null, status: "draft", error: null };

/** The attempted point is immutable, including after ambiguous disconnects.
 * A retry can only replay that same point, never silently submit a new one. */
export function syntaxAttemptAnswer(local: SyntaxAnswerLocal, point: SyntaxPoint): SyntaxAnswerLocal {
  if (local.attempted || local.receipt) return local;
  return { ...local, draft: point, attempted: point, status: "pending", error: null };
}

export function syntaxReceiveAnswer(local: SyntaxAnswerLocal, message: SyntaxOutgoingMessage | null, gameId: string, roundId: string): SyntaxAnswerLocal {
  if (message?.type === "syntax:answer-ack" && syntaxMatchesRound(message.receipt, gameId, roundId)) {
    return { ...local, draft: null, attempted: message.receipt.point, receipt: message.receipt, status: "accepted", error: null };
  }
  if (message?.type === "syntax:error" && message.command === "syntax:answer" && syntaxMatchesRound(message, gameId, roundId) && local.attempted && !local.receipt) {
    return { ...local, status: "rejected", error: message.message };
  }
  return local;
}

/** Serial pagination: the wire response has no offset field, so infer its start
 * from nextOffset/total. This rejects duplicate and out-of-order pages without
 * deduplicating coordinates (two people can click exactly the same point). */
export class SyntaxClickAccumulator {
  readonly roundIndex: number;
  points: readonly SyntaxPoint[];
  total: number;
  nextOffset: number | null;
  pendingOffset: number | null = null;
  private requested = new Set<number>();

  constructor(page: SyntaxClickPage) {
    this.roundIndex = page.roundIndex;
    this.points = [...page.points];
    this.total = page.total;
    this.nextOffset = page.nextOffset;
  }

  request(): number | null {
    const offset = this.nextOffset;
    if (offset === null || this.pendingOffset !== null || this.requested.has(offset) || offset !== this.points.length || offset >= this.total) return null;
    this.requested.add(offset);
    this.pendingOffset = offset;
    return offset;
  }

  accept(page: SyntaxClickPage): boolean {
    const offset = this.pendingOffset;
    const end = page.nextOffset ?? page.total;
    if (offset === null || page.roundIndex !== this.roundIndex || page.total !== this.total || end - page.points.length !== offset || page.points.length === 0 || end > this.total || (page.nextOffset !== null && (end <= offset || end >= this.total))) return false;
    this.points = [...this.points, ...page.points];
    this.nextOffset = page.nextOffset;
    this.pendingOffset = null;
    return true;
  }

  /** Explicit user retry only, so a missing/error response cannot spin effects. */
  retry(): void {
    if (this.pendingOffset !== null) this.requested.delete(this.pendingOffset);
    this.pendingOffset = null;
  }
}
