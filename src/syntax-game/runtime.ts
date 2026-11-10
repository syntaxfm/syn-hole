import { abortSyntaxSession, advanceSyntaxSession, closeExpiredSyntaxRound, joinSyntaxSession, revealSyntaxRound, startSyntaxRound } from "~/syntax-game/session";
import { parseSyntaxLibrary, parseSyntaxSavedSet, parseSyntaxPoint, SYNTAX_MAX_PLAYERS } from "~/syntax-game/validation";
import { syntaxRoundId, SyntaxProtocolError } from "~/syntax-game/protocol";
import type { SyntaxCommand, SyntaxAnswerAck } from "./protocol";
import type { SyntaxPlayer, SyntaxSession, SyntaxSessionSnapshot, SyntaxAnswer } from "./types";
import { syntaxIsHit } from "~/syntax-game/geometry";
import { assertSyntaxTimestamp, scoreSyntaxAnswer } from "~/syntax-game/scoring";
import { syntaxAnswerReceipt } from "~/syntax-game/projections";
import { SyntaxRuntimeStore } from "~/syntax-game/storage-runtime";
import type { RuntimeStorage, SyntaxRoomRecord } from "./storage-runtime";

export class SyntaxRuntime {
  private store: SyntaxRuntimeStore;
  private record: SyntaxRoomRecord;
  private tail: Promise<unknown> = Promise.resolve();
  private launching = false;
  private storage: RuntimeStorage;
  private snapshot: (setId: string, options: { id: string; askPlayMode: boolean; submissionMode: "first-click" | "confirm" }) => Promise<SyntaxSessionSnapshot>;
  private changed: () => void;
  private clock: () => number;
  constructor(storage: RuntimeStorage, snapshot: SyntaxRuntime["snapshot"], changed: () => void, clock = Date.now) {
    this.storage = storage;
    this.snapshot = snapshot;
    this.changed = changed;
    this.clock = clock;
    this.store = new SyntaxRuntimeStore(storage);
    this.record = this.store.load();
  }
  get mode() { return this.record.mode; }
  get session() { return this.record.session; }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  private deadline() {
    const s = this.session;
    return this.mode === "syntax" && s?.phase === "open" ? s.timing!.deadlineAt : null;
  }
  private async alarm() {
    const deadline = this.deadline();
    if (deadline !== null) await this.storage.setAlarm(deadline);
    else await this.storage.deleteAlarm();
  }
  private commit(record: SyntaxRoomRecord, accepted?: { answer?: SyntaxAnswer; player: SyntaxPlayer }) {
    this.store.save(record, accepted);
    this.record = record;
    this.changed();
  }
  private expire() {
    const session = this.session;
    if (!session || this.mode !== "syntax") return;
    const closed = closeExpiredSyntaxRound(session, this.clock());
    if (closed !== session) this.commit({ ...this.record, session: closed });
  }
  /** Every event and alarm reconciles timestamps. Late wake ONLY closes. */
  reconcile() {
    return this.serial(async () => { try { this.expire(); } finally { await this.alarm(); } });
  }
  join(player: SyntaxPlayer) {
    return this.serial(async () => {
      try {
        this.expire();
        if (this.mode !== "syntax" || !this.session || ["finished", "aborted"].includes(this.session.phase)) return;
        if (this.session.players.length >= SYNTAX_MAX_PLAYERS && !this.session.players.some(existing => existing.id === player.id)) return false;
        const session = joinSyntaxSession(this.session, player);
        if (session !== this.session) this.commit({ ...this.record, session }, { player: session.players.at(-1)! });
        return true;
      } finally { await this.alarm(); }
    });
  }
  assertRound(gameId: string, roundId: string): SyntaxSession {
    const s = this.session;
    if (this.mode !== "syntax" || !s) throw new SyntaxProtocolError("inactive-mode", "Syntax mode is inactive.");
    if (gameId !== s.snapshot.id || roundId !== syntaxRoundId(s.snapshot.id, s.roundIndex)) throw new SyntaxProtocolError("stale-round", "Stale game or round.");
    return s;
  }
  /** Caller captures receivedAt before ANY await and orders WebSocket events at
   * entry. An alarm may have closed the same round while this answer waited;
   * receipt time, not processing time, decides eligibility. Never accept after
   * reveal/advance/abort. Those lifecycle events cannot overtake earlier socket
   * messages in PollRoom's ingress queue. No client timing claims are accepted. */
  answer(command: Extract<SyntaxCommand, { type: "syntax:answer" }>, identity: { role: string; voterId: string | null }, receivedAt: number): Promise<SyntaxAnswerAck> {
    return this.serial(async () => {
      try {
        if (identity.role !== "audience" || !identity.voterId) throw new SyntaxProtocolError("forbidden", "Only audience connections may submit answers.");
        const s = this.assertRound(command.gameId, command.roundId);
        const point = parseSyntaxPoint(command.point);
        const player = s.players.find((p) => p.id === identity.voterId);
        if (!player) throw new SyntaxProtocolError("not-joined", "Join the game before answering.");
        const previous = s.answers.find((a) => a.playerId === player.id && a.roundIndex === s.roundIndex);
        if (previous) {
          if (previous.point.x !== point.x || previous.point.y !== point.y) throw new SyntaxProtocolError("already-submitted", "A different final answer is already locked for this round.");
          return { type: "syntax:answer-ack", status: "replayed", receipt: syntaxAnswerReceipt(s, previous) };
        }
        assertSyntaxTimestamp(receivedAt);
        if (!s.timing || (s.phase !== "open" && s.phase !== "closed") || receivedAt < s.timing.openedAt || receivedAt >= s.timing.deadlineAt) throw new SyntaxProtocolError("not-open", "The answer was not received within this round's open interval.");
        const { entry } = s.snapshot.rounds[s.roundIndex];
        const correct = syntaxIsHit(point, entry.targets, entry.image);
        const answer: SyntaxAnswer = {
          playerId: player.id, roundIndex: s.roundIndex, point, receivedAt,
          elapsedMs: receivedAt - s.timing.openedAt, correct, points: scoreSyntaxAnswer(correct, receivedAt, s.timing),
        };
        const session = closeExpiredSyntaxRound({ ...s, answers: [...s.answers, answer] }, this.clock());
        this.commit({ ...this.record, session }, { answer, player });
        return { type: "syntax:answer-ack", status: "accepted", receipt: syntaxAnswerReceipt(session, answer) };
      } finally {
        this.expire();
        await this.alarm();
      }
    });
  }
  async command(command: SyntaxCommand, role: string, askPlayMode: boolean, players: SyntaxPlayer[] = [], receivedAt = this.clock()) {
    if (role !== "host") throw new SyntaxProtocolError("forbidden", "Only host connections may send this command.");
    if (command.type === "syntax:launch") {
      // Reserve synchronously before any await. A switch-back invalidates the
      // generation; concurrent launches cannot race to replace one another.
      if (this.launching || (this.mode === "syntax" && this.session && !["finished", "aborted"].includes(this.session.phase))) throw new Error("A game or launch is already active.");
      this.launching = true;
      const generation = this.record.generation;
      const mode = this.mode;
      try {
        const id = crypto.randomUUID();
        const snapshot = await this.snapshot(command.setId, { id, askPlayMode, submissionMode: command.submissionMode });
        // Validate the internal response, not mutable library reads. Keep the
        // registry's exact preparedAt and immutable revision URLs.
        if (snapshot.id !== id || snapshot.askPlayMode !== askPlayMode || snapshot.submissionMode !== command.submissionMode) throw new Error("Invalid registry snapshot.");
        parseSyntaxSavedSet({ id: snapshot.setId, title: snapshot.title, defaultDurationMs: snapshot.rounds[0]?.durationMs, submissionMode: snapshot.submissionMode, rounds: snapshot.rounds.map((r) => ({ entryId: r.entry.id, durationMs: r.durationMs })) });
        parseSyntaxLibrary(snapshot.rounds.map((r) => r.entry));
        await this.serial(async () => {
          try {
            this.expire();
            if (this.record.generation !== generation || this.mode !== mode) throw new Error("Launch superseded by a room mode change.");
            let session: SyntaxSession = { snapshot, phase: "prepared", roundIndex: 0, timing: null, players: [], answers: [], revealedRoundIndexes: [] };
            for (const player of players) {
              if (session.players.length >= SYNTAX_MAX_PLAYERS) break;
              session = joinSyntaxSession(session, player);
            }
            this.commit({ mode: "syntax", generation: generation + 1, session });
          } finally { await this.alarm(); }
        });
      } finally { this.launching = false; }
      return;
    }
    return this.serial(async () => {
      try {
        this.expire();
        if (command.type === "syntax:polls") {
          if (this.session && this.mode === "syntax" && !["finished", "aborted"].includes(this.session.phase)) throw new Error("Finish or explicitly abort the active game first.");
          this.commit({ ...this.record, mode: "poll", generation: this.record.generation + 1 });
          return;
        }
        const s = this.session;
        if (this.mode !== "syntax" || !s) throw new Error("Syntax mode is inactive.");
        if (command.gameId !== s.snapshot.id || command.roundId !== syntaxRoundId(s.snapshot.id, s.roundIndex)) throw new Error("Stale game or round.");
        let session: SyntaxSession;
        switch (command.type) {
          case "syntax:open":
            session = startSyntaxRound(s, this.clock());
            // SQL and alarms aren't atomic. Pre-arm before committing OPEN;
            // finally reconciles on either success or failure. A crash before
            // commit leaves a harmless alarm; after commit always has a wakeup.
            await this.storage.setAlarm(session.timing!.deadlineAt);
            break;
          case "syntax:reveal":
            // An early Reveal waiting behind I/O must not become valid merely
            // because processing crossed the deadline: it could otherwise jump
            // a later, still-on-time answer in the ingress queue.
            if (s.timing && receivedAt < s.timing.deadlineAt) throw new SyntaxProtocolError("command-rejected", "Wait until the round timer has expired before revealing.");
            session = revealSyntaxRound(s); break;
          case "syntax:next":
            if (s.roundIndex === s.snapshot.rounds.length - 1) throw new Error("Use finish on the final round.");
            session = advanceSyntaxSession(s); break;
          case "syntax:finish":
            if (s.roundIndex !== s.snapshot.rounds.length - 1) throw new Error("Only the final revealed round can finish.");
            session = advanceSyntaxSession(s); break;
          case "syntax:abort": session = abortSyntaxSession(s); break;
          default: throw new Error("Unsupported lifecycle command.");
        }
        this.commit({ ...this.record, session });
      } finally { await this.alarm(); }
    });
  }
}
