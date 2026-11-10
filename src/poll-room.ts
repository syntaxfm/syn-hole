import { Server } from "partyserver";
import type { Connection, ConnectionContext } from "partyserver";
import starterQuestionsData from "./data/questions";
import { SyntaxRuntime } from "./syntax-game/runtime";
import { SyntaxRuntimeStore } from "./syntax-game/storage-runtime";
import { handleInternalSyntaxHistory } from "./syntax-game/history-http";
import { parseSyntaxCommand, syntaxRoundId, SyntaxProtocolError } from "./syntax-game/protocol";
import type { SyntaxStateMessage, SyntaxOutgoingMessage } from "./syntax-game/protocol";
import type { SyntaxPlayer, SyntaxSessionSnapshot, SyntaxSession } from "./syntax-game/types";
import { projectSyntaxSession, buildSyntaxSharedProjection, projectSyntaxClickPage, syntaxAnswerReceipt } from "./syntax-game/projections";
import type { SyntaxSharedProjection } from "./syntax-game/projections";
import { deleteUnusedRoomImages, listRoomImages, loadOptionImages } from "./poll-images";
import { DEFAULT_PLAY_MODE, PLAY_MODES, isPlayMode, parseRoomSettings } from "./utils/play-mode";
import { getOptionName, parseQuestion, parseQuestionList } from "./utils/questions";
import type {
  IncomingMessage,
  NumberWinner,
  OutgoingMessage,
  PlayMode,
  PollOptionImage,
  PollPhase,
  PollQuestion,
  PollQuestionPublic,
  PollRole,
  RoomQuestionsResponse,
  RoomSettings,
  VoteCounts,
} from "./types";

type PollConnectionState = {
  role: PollRole;
  voterId: string | null;
  displayName: string | null;
  playMode?: PlayMode;
  syntaxProtocol?: 1;
  syntaxVoterId?: string;
  syntaxReady?: { roundId: string; status: "ready" | "failed" };
  syntaxReadyRate?: { at: number; count: number };
};

/** Every room starts with these the first time it loads; after that the room owns its list. */
export const STARTER_QUESTIONS = parseQuestionList(starterQuestionsData);

export class PollRoom extends Server<Env> {
  static options = { hibernate: true };

  private questions: PollQuestion[] = [];
  private currentQuestionId: string | null = null;
  private readonly phaseByQuestionId = new Map<string, PollPhase>();
  private readonly votesByQuestionId = new Map<string, Map<string, string[]>>();
  private optionImages: Record<string, PollOptionImage> = {};
  private askPlayMode = false;
  private readonly playModeByVoterId = new Map<string, PlayMode>();
  private stateLoaded = false;
  private loadStatePromise: Promise<void> | null = null;
  private syntax!: SyntaxRuntime;
  private messageTail: Promise<unknown> = Promise.resolve();
  private syntaxProjection: { session: SyntaxSession; shared: SyntaxSharedProjection } | null = null;

  async onStart() {
    // PartyServer invokes onStart even when a hibernated socket wakes via close.
    // Hydrate BOTH subsystems before any broadcast can observe default state.
    await this.ensureStateLoaded();
    await this.syntax.reconcile();
  }

  async onAlarm(): Promise<void> {
    await this.ensureStateLoaded();
    await this.syntax.reconcile();
  }

  async onRequest(request: Request): Promise<Response> {
    await this.ensureStateLoaded();
    const url = new URL(request.url);

    if (url.pathname.startsWith("/syntax/history")) {
      return handleInternalSyntaxHistory(request, new SyntaxRuntimeStore(this.ctx.storage));
    }
    await this.syntax.reconcile();

    if (request.method !== "GET" && this.syntax.mode !== "poll") {
      return Response.json({ error: "Poll mode is inactive; finish or abort the syntax game and switch back first." }, { status: 409 });
    }

    if (url.pathname.endsWith("/images-changed") && request.method === "POST") {
      await this.refreshOptionImages();
      this.broadcastState();
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith("/questions") && request.method === "GET") {
      const response: RoomQuestionsResponse = {
        questions: this.questions,
        images: await listRoomImages(this.env.POLL_IMAGES, this.name),
      };
      return Response.json(response, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname.endsWith("/questions") && request.method === "PUT") {
      return this.handleReplaceQuestions(request);
    }

    if (url.pathname.endsWith("/settings") && request.method === "GET") {
      const settings: RoomSettings = { askPlayMode: this.askPlayMode };
      return Response.json(settings, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname.endsWith("/settings") && request.method === "PUT") {
      let settings: RoomSettings;
      try {
        settings = parseRoomSettings(await request.json());
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Invalid settings." },
          { status: 400 }
        );
      }
      if (this.syntax.mode !== "poll") return Response.json({ error: "Poll mode is inactive." }, { status: 409 });
      this.askPlayMode = settings.askPlayMode;
      this.sql`
        INSERT INTO room_meta (key, value) VALUES ('askPlayMode', ${settings.askPlayMode ? "1" : "0"})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `;
      this.broadcastState();
      return Response.json(settings);
    }

    if (url.pathname.endsWith("/stats") && request.method === "GET") {
      const connections = Array.from(this.getConnections<PollConnectionState>());
      let audienceCount = 0;
      let hostCount = 0;
      let projectorCount = 0;
      for (const conn of connections) {
        if (conn.state?.role === "audience") audienceCount++;
        else if (conn.state?.role === "host") hostCount++;
        else if (conn.state?.role === "projector") projectorCount++;
      }

      return Response.json({
        room: this.name,
        currentQuestionIndex: this.getCurrentQuestionIndex(),
        totalQuestions: this.questions.length,
        participants: this.getConnectedParticipantCount(),
        audienceCount,
        hostCount,
        projectorCount,
        questions: this.questions.map((question, index) => ({
          index,
          id: question.id,
          prompt: question.prompt,
          phase: this.phaseByQuestionId.get(question.id) ?? "idle",
          totalVotes: this.votesByQuestionId.get(question.id)?.size ?? 0,
        })),
      });
    }

    if (url.pathname.endsWith("/reset") && request.method === "POST") {
      await this.resetSession();
      return Response.json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  }

  async onConnect(conn: Connection<PollConnectionState>, ctx: ConnectionContext) {
    await this.ensureStateLoaded();
    await this.syntax.reconcile();

    const url = new URL(ctx.request.url);
    const role = getRole(url.searchParams.get("role"));
    const voterId =
      role === "audience"
        ? getSafeVoterId(url.searchParams.get("voterId"), conn.id)
        : null;
    const displayName =
      role === "audience" ? sanitizeAudienceName(url.searchParams.get("name")) : null;

    const playMode = url.searchParams.get("playMode");
    conn.setState({ role, voterId, displayName, ...(isPlayMode(playMode) ? { playMode } : {}), ...(url.searchParams.get("syntaxProtocol") === "1" ? { syntaxProtocol: 1 as const } : {}) });
    if (voterId && isPlayMode(playMode) && this.syntax.mode === "poll") this.setPlayMode(voterId, playMode);
    const syntaxVoterId = this.syntaxPlayerId(conn);
    if (syntaxVoterId && await this.syntax.join({ id: syntaxVoterId, name: displayName ?? "Anonymous", playMode: isPlayMode(playMode) ? playMode : this.getPlayModeForVoter(voterId!) }) === false) {
      this.rejectSyntaxCapacity(conn);
      return;
    }
    this.broadcastState();
  }

  onMessage(
    conn: Connection<PollConnectionState>,
    message: string | ArrayBuffer | ArrayBufferView
  ) {
    const receivedAt = Date.now(); // Capture before hydration, alarms, or queue awaits.
    // Reject readiness floods BEFORE they enter the syntax lifecycle queue or
    // cause SQL/alarm work. Persist the limiter across connection hibernation.
    let raw: unknown;
    if (typeof message === "string") { try { raw = JSON.parse(message); } catch {} }
    if (raw && typeof raw === "object" && "type" in raw && raw.type === "syntax:ready") {
      const value = raw as Record<string, unknown>;
      const state = conn.state;
      if (state?.syntaxProtocol !== 1) return;
      if (state.syntaxReady && state.syntaxReady.roundId === value.roundId && state.syntaxReady.status === value.status) return;
      const previous = state.syntaxReadyRate;
      const rate = previous && receivedAt >= previous.at && receivedAt - previous.at < 1000 ? previous : { at: receivedAt, count: 0 };
      if (rate.count >= 2) return;
      conn.setState({ ...state, syntaxReadyRate: { at: rate.at, count: rate.count + 1 } });
    }
    // Enqueue synchronously on entry. Later Reveal/Next/Abort socket events must
    // not overtake answers waiting for initial I/O. Alarms may close, never reveal.
    const result = this.messageTail.then(() => this.processMessage(conn, message, receivedAt, raw));
    this.messageTail = result.catch(() => {});
    return result;
  }

  private async processMessage(conn: Connection<PollConnectionState>, message: string | ArrayBuffer | ArrayBufferView, receivedAt: number, raw: unknown) {
    if (typeof message !== "string") {
      await this.ensureStateLoaded();
      await this.syntax.reconcile();
      return;
    }

    if (raw && typeof raw === "object" && "type" in raw && typeof raw.type === "string" && raw.type.startsWith("syntax:")) {
      try {
        await this.ensureStateLoaded();
        await this.syntax.reconcile();
        if (conn.state?.syntaxProtocol !== 1) { this.sendError(conn, "Negotiate syntaxProtocol=1 first."); return; }
        let command;
        try { command = parseSyntaxCommand(raw); }
        catch (error) { throw new SyntaxProtocolError("invalid-payload", error instanceof Error ? error.message : "Invalid syntax command."); }
        if (command.type === "syntax:answer") {
          this.sendSyntax(conn, await this.syntax.answer(command, { role: conn.state?.role ?? "audience", voterId: this.syntaxPlayerId(conn) }, receivedAt));
        } else if (command.type === "syntax:clicks") {
          const s = this.syntax.assertRound(command.gameId, command.roundId);
          this.sendSyntax(conn, { type: "syntax:clicks", gameId: command.gameId, roundId: command.roundId, page: projectSyntaxClickPage(s, this.sharedSyntaxProjection(s), command.offset) });
        } else if (command.type === "syntax:ready") {
          this.syntax.assertRound(command.gameId, command.roundId);
          if (conn.state?.syntaxReady?.roundId === command.roundId && conn.state.syntaxReady.status === command.status) return;
          conn.setState({ ...conn.state, syntaxReady: { roundId: command.roundId, status: command.status } });
          // Readiness is host-only telemetry, not audience/poll state. One client
          // must not be able to fan out redundant broadcasts to the entire room.
          for (const host of this.getConnections<PollConnectionState>()) {
            if (host.state?.role === "host" && host.state.syntaxProtocol === 1) this.sendSyntax(host, this.buildSyntaxState(host));
          }
        } else {
          await this.syntax.command(command, conn.state?.role ?? "audience", this.askPlayMode, this.syntaxPlayers(), receivedAt);
          // Include sockets that joined while the registry snapshot was in flight.
          if (command.type === "syntax:launch") {
            const joined = new Set(this.syntax.session?.players.map(player => player.id));
            for (const connection of this.getConnections<PollConnectionState>()) {
              const state = connection.state;
              const id = this.syntaxPlayerId(connection);
              if (!state || !id || joined.has(id)) continue;
              const accepted = await this.syntax.join({ id, name: state.displayName ?? "Anonymous", playMode: state.playMode ?? this.getPlayModeForVoter(state.voterId!) });
              if (accepted === false) this.rejectSyntaxCapacity(connection);
              else joined.add(id);
            }
          }
        }
      } catch (error) {
        this.sendSyntax(conn, {
          type: "syntax:error", command: raw.type.slice(0, 64),
          code: error instanceof SyntaxProtocolError ? error.code : raw.type === "syntax:answer" ? "internal-error" : "command-rejected",
          message: error instanceof SyntaxProtocolError ? error.message : raw.type === "syntax:answer" ? "Answer could not be confirmed. Retry the identical point and round IDs." : error instanceof Error ? error.message : "Syntax command failed.",
          ...("gameId" in raw && typeof raw.gameId === "string" ? { gameId: raw.gameId.slice(0, 128) } : {}),
          ...("roundId" in raw && typeof raw.roundId === "string" ? { roundId: raw.roundId.slice(0, 160) } : {}),
        });
      }
      return;
    }

    await this.ensureStateLoaded();
    await this.syntax.reconcile();
    if (this.syntax.mode !== "poll") { this.sendError(conn, "Poll mode is inactive."); return; }

    const incoming = parseIncomingMessage(message);
    if (!incoming) {
      this.sendError(conn, "Invalid message payload.");
      return;
    }

    if (isHostMessage(incoming) && conn.state?.role !== "host") {
      this.sendError(conn, "Only host connections may send this command.");
      return;
    }

    if (incoming.type === "vote") {
      await this.handleChoiceVote(conn, incoming.optionIds);
      return;
    }

    if (incoming.type === "vote-number") {
      await this.handleNumberVote(conn, incoming.value);
      return;
    }

    await this.handleHostCommand(incoming);
  }

  async onClose(
    _conn: Connection<PollConnectionState>,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    await this.ensureStateLoaded();
    await this.syntax.reconcile();
    this.broadcastState();
  }

  async onError(_conn: Connection<PollConnectionState>, _error: unknown): Promise<void> {
    await this.ensureStateLoaded();
    await this.syntax.reconcile();
    this.broadcastState();
  }

  private async handleReplaceQuestions(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Body must be JSON." }, { status: 400 });
    }
    const rawQuestions =
      body && typeof body === "object" && "questions" in body ? body.questions : undefined;

    let questions: PollQuestion[];
    try {
      questions = parseQuestionList(rawQuestions);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Invalid questions." },
        { status: 400 }
      );
    }

    if (this.syntax.mode !== "poll") return Response.json({ error: "Poll mode is inactive." }, { status: 409 });
    this.replaceQuestions(questions);
    try {
      await deleteUnusedRoomImages(this.env.POLL_IMAGES, this.name, questions);
    } catch (error) {
      // Best effort: leftover images only cost storage and are retried on the next save.
      console.error("Failed to delete unused room images", error);
    }
    await this.refreshOptionImages();
    this.broadcastState();
    return Response.json({ ok: true });
  }

  /** Swaps in a new list, keeping phases and votes for questions and options that still exist. */
  private replaceQuestions(questions: PollQuestion[]) {
    this.questions = questions;
    this.sql`DELETE FROM room_question`;
    questions.forEach((question, position) => {
      this.sql`
        INSERT INTO room_question (position, id, data)
        VALUES (${position}, ${question.id}, ${JSON.stringify(question)})
      `;
    });

    for (const questionId of Array.from(this.phaseByQuestionId.keys())) {
      if (this.getQuestion(questionId)) continue;
      this.phaseByQuestionId.delete(questionId);
      this.sql`DELETE FROM room_phase WHERE question_id = ${questionId}`;
    }

    for (const [questionId, votes] of Array.from(this.votesByQuestionId.entries())) {
      const question = this.getQuestion(questionId);
      for (const [voterId, selection] of Array.from(votes.entries())) {
        const cleaned = question ? sanitizeStoredSelection(question, selection) : null;
        if (cleaned && cleaned.join() === selection.join()) continue;
        if (cleaned) {
          votes.set(voterId, cleaned);
        } else {
          votes.delete(voterId);
        }
        this.persistVote(questionId, voterId, cleaned ?? []);
      }
      if (votes.size === 0) this.votesByQuestionId.delete(questionId);
    }

    if (!this.currentQuestionId || !this.getQuestion(this.currentQuestionId)) {
      this.currentQuestionId = questions[0]?.id ?? null;
      this.persistCurrentQuestionId();
    }
  }

  private async handleChoiceVote(conn: Connection<PollConnectionState>, optionIds: string[]) {
    if (conn.state?.role !== "audience") {
      this.sendError(conn, "Only audience clients can submit votes.");
      return;
    }

    const phase = this.getCurrentPhase();
    if (phase !== "open") {
      this.sendError(conn, "Voting is currently closed.");
      return;
    }

    const question = this.getCurrentQuestion();
    if (!question || !conn.state.voterId) {
      this.sendError(conn, "Unable to register vote for current question.");
      return;
    }

    if (question.kind !== "choice") {
      this.sendError(conn, "This question expects a number guess, not multiple choice.");
      return;
    }

    const validated = validateChoiceSelection(question, optionIds);
    if (validated.ok === false) {
      this.sendError(conn, validated.message);
      return;
    }

    const votesForQuestion = this.getVotesForQuestion(question.id);

    if (validated.optionIds.length === 0) {
      votesForQuestion.delete(conn.state.voterId);
    } else {
      votesForQuestion.set(conn.state.voterId, validated.optionIds);
    }

    this.persistVote(question.id, conn.state.voterId, validated.optionIds);
    this.broadcastState();
  }

  private async handleNumberVote(conn: Connection<PollConnectionState>, value: number | null) {
    if (conn.state?.role !== "audience") {
      this.sendError(conn, "Only audience clients can submit votes.");
      return;
    }

    const phase = this.getCurrentPhase();
    if (phase !== "open") {
      this.sendError(conn, "Voting is currently closed.");
      return;
    }

    const question = this.getCurrentQuestion();
    if (!question || !conn.state.voterId) {
      this.sendError(conn, "Unable to register vote for current question.");
      return;
    }
    if (question.kind !== "number") {
      this.sendError(conn, "This question expects multiple-choice options.");
      return;
    }

    const validated = validateNumberGuess(question, value);
    if (validated.ok === false) {
      this.sendError(conn, validated.message);
      return;
    }

    const votesForQuestion = this.getVotesForQuestion(question.id);
    if (validated.value === null) {
      votesForQuestion.delete(conn.state.voterId);
      this.persistVote(question.id, conn.state.voterId, []);
      this.broadcastState();
      return;
    }

    const storedSelection = [String(validated.value)];
    votesForQuestion.set(conn.state.voterId, storedSelection);
    this.persistVote(question.id, conn.state.voterId, storedSelection);
    this.broadcastState();
  }

  private async handleHostCommand(
    message: Exclude<IncomingMessage, { type: "vote" | "vote-number" }>
  ) {
    switch (message.type) {
      case "set-question": {
        const question = Number.isInteger(message.questionIndex)
          ? this.questions[message.questionIndex]
          : undefined;
        if (!question) return;
        this.currentQuestionId = question.id;
        this.setPhase(question.id, "open");
        this.persistCurrentQuestionId();
        await this.refreshOptionImages();
        this.broadcastState();
        return;
      }
      case "open-voting": {
        if (!this.currentQuestionId) return;
        this.setPhase(this.currentQuestionId, "open");
        this.broadcastState();
        return;
      }
      case "close-voting": {
        if (!this.currentQuestionId) return;
        this.setPhase(this.currentQuestionId, "closed");
        this.broadcastState();
        return;
      }
      case "reveal": {
        if (!this.currentQuestionId) return;
        if (this.getCurrentPhase() === "open") {
          this.setPhase(this.currentQuestionId, "closed");
          this.broadcastState();
        }
        this.setPhase(this.currentQuestionId, "revealed");
        this.broadcastState();
        return;
      }
      case "reset-session": {
        await this.resetSession();
        return;
      }
    }
  }

  private async resetSession() {
    this.currentQuestionId = this.questions[0]?.id ?? null;
    this.phaseByQuestionId.clear();
    this.votesByQuestionId.clear();
    this.sql`DELETE FROM room_vote`;
    this.sql`DELETE FROM room_phase`;
    this.persistCurrentQuestionId();
    await this.refreshOptionImages();
    this.broadcastState();
  }

  /** Best effort: a failed R2 read shows options without images rather than breaking the room. */
  private async refreshOptionImages() {
    try {
      this.optionImages = await loadOptionImages(
        this.env.POLL_IMAGES,
        this.name,
        this.getCurrentQuestion()
      );
    } catch (error) {
      console.error("Failed to load poll option images", error);
      this.optionImages = {};
    }
  }

  private sendError(connection: Connection<unknown>, message: string) {
    try {
      connection.send(JSON.stringify({ type: "error", message } satisfies OutgoingMessage));
    } catch {
      // Connection may already be closed.
    }
  }

  private broadcastState() {
    const connections = Array.from(this.getConnections<PollConnectionState>());
    for (let index = 0; index < connections.length; index += 1) {
      this.sendState(connections[index]);
    }
  }

  private sendState(connection: Connection<PollConnectionState>) {
    try {
      connection.send(JSON.stringify(this.buildState(connection)));
      if (connection.state?.syntaxProtocol === 1) connection.send(JSON.stringify(this.buildSyntaxState(connection)));
    } catch {
      // Connection may already be closed.
    }
  }

  private sendSyntax(connection: Connection<PollConnectionState>, message: SyntaxOutgoingMessage) {
    if (connection.state?.syntaxProtocol !== 1) return;
    try { connection.send(JSON.stringify(message)); } catch { /* Closed socket; reconnect uses persisted receipt. */ }
  }

  private sharedSyntaxProjection(session: SyntaxSession): SyntaxSharedProjection {
    if (this.syntaxProjection?.session !== session) this.syntaxProjection = { session, shared: buildSyntaxSharedProjection(session) };
    return this.syntaxProjection.shared;
  }

  private syntaxPlayers(): SyntaxPlayer[] {
    return Array.from(this.getConnections<PollConnectionState>()).flatMap((conn) => {
      const state = conn.state;
      const id = this.syntaxPlayerId(conn);
      return state && id ? [{ id, name: state.displayName ?? "Anonymous", playMode: state.playMode ?? this.getPlayModeForVoter(state.voterId!) }] : [];
    });
  }

  private syntaxPlayerId(connection: Connection<PollConnectionState>): string | null {
    const state = connection.state;
    if (state?.role !== "audience" || !state.voterId) return null;
    if (state.syntaxVoterId) return state.syntaxVoterId;
    if (/^[a-zA-Z0-9_-]{1,100}$/.test(state.voterId)) return state.voterId;
    // The new game requires valid IDs, unlike legacy polls. Normalize ONLY its
    // identity, retaining the original poll voter ID and reconnect semantics.
    const id = crypto.randomUUID();
    connection.setState({ ...state, syntaxVoterId: id });
    return id;
  }

  private rejectSyntaxCapacity(connection: Connection<PollConnectionState>) {
    this.sendError(connection, "Game is at capacity. Try joining the next game.");
    connection.close(1013, "Game is at capacity.");
  }

  private buildSyntaxState(connection: Connection<PollConnectionState>): SyntaxStateMessage {
    const s = this.syntax.session;
    const role = connection.state?.role ?? "audience";
    const shared = s ? this.sharedSyntaxProjection(s) : null;
    const voterId = role === "audience" ? this.syntaxPlayerId(connection) ?? undefined : undefined;
    const ownAnswer = voterId ? shared?.currentAnswers.get(voterId) : undefined;
    const roundId = s ? syntaxRoundId(s.snapshot.id, s.roundIndex) : null;
    const connections = role === "host" ? Array.from(this.getConnections<PollConnectionState>()).filter((c) => c.state?.syntaxProtocol === 1) : [];
    return {
      type: "syntax:state", protocol: 1, mode: this.syntax.mode, serverNow: Date.now(), role, roundId,
      session: s && shared ? projectSyntaxSession(s, voterId, shared) : null,
      yourReceipt: s && ownAnswer ? syntaxAnswerReceipt(s, ownAnswer) : null,
      host: role === "host" ? {
        connected: connections.length,
        ready: connections.filter((c) => c.state?.syntaxReady?.roundId === roundId && c.state.syntaxReady.status === "ready").length,
        failed: connections.filter((c) => c.state?.syntaxReady?.roundId === roundId && c.state.syntaxReady.status === "failed").length,
      } : null,
    };
  }

  private buildState(connection: Connection<PollConnectionState>): OutgoingMessage {
    const role = connection.state?.role ?? "audience";
    const voterId = connection.state?.voterId ?? null;
    const question = this.getCurrentQuestion();
    const phase = this.getCurrentPhase();
    const votesForQuestion = question ? this.getVotesForQuestion(question.id) : new Map<string, string[]>();
    const canRevealCorrect = role === "host" || phase === "revealed";
    const questionPublic = question ? toPublicQuestion(question, canRevealCorrect) : null;
    const resultsVisible = this.shouldShowResults(role, question);
    const voteCounts = resultsVisible
      ? getVoteCounts(question, votesForQuestion)
      : getEmptyVoteCounts(question);
    const yourSelection = role === "audience" && voterId ? (votesForQuestion.get(voterId) ?? []) : [];
    const yourVoteOptionIds =
      question?.kind === "choice" ? yourSelection : [];
    const yourNumberGuess =
      question?.kind === "number" ? parseStoredNumberGuess(question, yourSelection) : null;
    const reveal =
      canRevealCorrect && question
        ? question.kind === "choice"
          ? {
              kind: "choice" as const,
              correctOptionIds: [...question.correctOptionIds],
              isCorrect:
                role === "audience"
                  ? isSelectionCorrect(yourVoteOptionIds, question.correctOptionIds)
                  : undefined,
            }
          : {
              kind: "number" as const,
              correctNumber: question.correctNumber,
              winners: this.getNumberWinners(question),
              isWinner:
                role === "audience" && voterId
                  ? yourNumberGuess !== null &&
                    yourNumberGuess === this.getWinningGuessForVoter(question, voterId)
                  : undefined,
            }
        : null;

    const score = role === "audience" && voterId ? this.getScoreForVoter(voterId) : null;
    const participants = this.getConnectedParticipantCount();

    return {
      type: "state",
      role,
      room: this.name,
      phase,
      currentQuestionIndex: this.getCurrentQuestionIndex(),
      totalQuestions: this.questions.length,
      askPlayMode: this.askPlayMode,
      question: questionPublic,
      optionImages: this.optionImages,
      voteCounts,
      resultsVisible,
      totalResponses: votesForQuestion.size,
      participants,
      yourVoteOptionIds,
      yourNumberGuess,
      score,
      reveal,
      host: role === "host" ? { questions: this.questions } : null,
    };
  }

  private getConnectedParticipantCount(): number {
    const identities = new Set<string>();
    const connections = Array.from(this.getConnections<PollConnectionState>());

    for (let index = 0; index < connections.length; index += 1) {
      const connection = connections[index];
      const state = connection.state;

      if (state?.role === "audience" && state.voterId) {
        identities.add(`audience:${state.voterId}`);
        continue;
      }

      identities.add(`connection:${connection.id}`);
    }

    return identities.size;
  }

  private getQuestion(questionId: string): PollQuestion | null {
    return this.questions.find((question) => question.id === questionId) ?? null;
  }

  private getCurrentQuestion(): PollQuestion | null {
    return this.currentQuestionId ? this.getQuestion(this.currentQuestionId) : null;
  }

  /** The host UI and counters still speak in list positions; 0 when nothing is selected. */
  private getCurrentQuestionIndex(): number {
    const index = this.questions.findIndex((question) => question.id === this.currentQuestionId);
    return index === -1 ? 0 : index;
  }

  private getPlayModeForVoter(voterId: string): PlayMode {
    return this.playModeByVoterId.get(voterId) ?? DEFAULT_PLAY_MODE;
  }

  /** One winner for the whole room, or one per play mode when the room asks for it. */
  private getNumberWinners(question: Extract<PollQuestion, { kind: "number" }>): NumberWinner[] {
    if (!this.askPlayMode) {
      return [{ playMode: null, ...this.getNumberWinnerResult(question, null) }];
    }
    return PLAY_MODES.map((playMode) => ({
      playMode,
      ...this.getNumberWinnerResult(question, playMode),
    }));
  }

  /** The winning guess this voter is competing against: their group's when the room splits players. */
  private getWinningGuessForVoter(
    question: Extract<PollQuestion, { kind: "number" }>,
    voterId: string
  ): number | null {
    const playMode = this.askPlayMode ? this.getPlayModeForVoter(voterId) : null;
    return this.getNumberWinnerResult(question, playMode).winningGuess;
  }

  /** Closest guess without going over, among everyone or only players in one play mode. */
  private getNumberWinnerResult(
    question: Extract<PollQuestion, { kind: "number" }>,
    playMode: PlayMode | null
  ): {
    winningGuess: number | null;
    winnerCount: number;
  } {
    const votesForQuestion = this.getVotesForQuestion(question.id);
    let winningGuess: number | null = null;
    let winnerCount = 0;

    for (const [voterId, selection] of votesForQuestion) {
      if (playMode !== null && this.getPlayModeForVoter(voterId) !== playMode) continue;
      const guess = parseStoredNumberGuess(question, selection);
      if (guess === null || guess > question.correctNumber) continue;
      if (winningGuess === null || guess > winningGuess) {
        winningGuess = guess;
        winnerCount = 1;
      } else if (guess === winningGuess) {
        winnerCount += 1;
      }
    }

    return { winningGuess, winnerCount };
  }

  private shouldShowResults(role: PollRole, question: PollQuestion | null): boolean {
    if (role === "host") return true;
    if (!question) return false;
    if (!question.hideResultsUntilReveal) return true;
    return this.getCurrentPhase() === "revealed";
  }

  private getCurrentPhase(): PollPhase {
    if (!this.currentQuestionId) return "idle";
    return this.phaseByQuestionId.get(this.currentQuestionId) ?? "idle";
  }

  private getVotesForQuestion(questionId: string): Map<string, string[]> {
    const existing = this.votesByQuestionId.get(questionId);
    if (existing) return existing;
    const created = new Map<string, string[]>();
    this.votesByQuestionId.set(questionId, created);
    return created;
  }

  private getScoreForVoter(voterId: string): {
    answered: number;
    correct: number;
    totalQuestions: number;
  } {
    let answered = 0;
    let correct = 0;

    for (const question of this.questions) {
      const selection = this.votesByQuestionId.get(question.id)?.get(voterId);
      if (!selection || selection.length === 0) continue;
      const phase = this.phaseByQuestionId.get(question.id) ?? "idle";

      if (question.kind === "choice") {
        answered += 1;
        if (phase === "revealed" && isSelectionCorrect(selection, question.correctOptionIds)) {
          correct += 1;
        }
        continue;
      }

      const guess = parseStoredNumberGuess(question, selection);
      if (guess === null) continue;
      answered += 1;
      if (phase === "revealed" && guess === this.getWinningGuessForVoter(question, voterId)) {
        correct += 1;
      }
    }

    return { answered, correct, totalQuestions: this.questions.length };
  }

  private async ensureStateLoaded() {
    if (this.stateLoaded) return;
    if (this.loadStatePromise) {
      await this.loadStatePromise;
      return;
    }

    this.loadStatePromise = this.loadStateFromStorage();
    try {
      await this.loadStatePromise;
    } finally {
      this.loadStatePromise = null;
    }
  }

  private async loadStateFromStorage() {
    this.ensureSchema();
    this.syntax = new SyntaxRuntime(this.ctx.storage, async (setId, options) => {
      const registry = this.env.AdminRegistry.get(this.env.AdminRegistry.idFromName("global"));
      const response = await registry.fetch(new Request(`http://internal/syntax/sets/${encodeURIComponent(setId)}/snapshot`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(options),
      }));
      if (!response.ok) throw new Error("Could not prepare launchable set snapshot.");
      return await response.json() as SyntaxSessionSnapshot;
    }, () => this.broadcastState());
    this.initializeQuestionsOnce();
    this.phaseByQuestionId.clear();
    this.votesByQuestionId.clear();

    const questionRows = this.sql<{ id: string; data: string }>`
      SELECT id, data FROM room_question ORDER BY position
    `;
    this.questions = [];
    questionRows.forEach((row, index) => {
      try {
        this.questions.push(parseQuestion(JSON.parse(row.data), index));
      } catch (error) {
        console.error(`Skipping invalid stored question "${row.id}"`, error);
      }
    });

    const currentRows = this.sql<{ value: string }>`
      SELECT value FROM room_meta WHERE key = 'currentQuestionId' LIMIT 1
    `;
    const storedCurrentId = currentRows[0]?.value;
    this.currentQuestionId =
      storedCurrentId && this.getQuestion(storedCurrentId)
        ? storedCurrentId
        : (this.questions[0]?.id ?? null);

    const askPlayModeRows = this.sql<{ value: string }>`
      SELECT value FROM room_meta WHERE key = 'askPlayMode' LIMIT 1
    `;
    this.askPlayMode = askPlayModeRows[0]?.value === "1";

    this.playModeByVoterId.clear();
    for (const row of this.sql<{ voter_id: string; play_mode: string }>`
      SELECT voter_id, play_mode FROM room_player
    `) {
      if (isPlayMode(row.play_mode)) this.playModeByVoterId.set(row.voter_id, row.play_mode);
    }

    const phaseRows = this.sql<{ question_id: string; phase: string }>`
      SELECT question_id, phase FROM room_phase
    `;
    for (const row of phaseRows) {
      if (!this.getQuestion(row.question_id) || !isPollPhase(row.phase)) continue;
      this.phaseByQuestionId.set(row.question_id, row.phase);
    }

    const voteRows = this.sql<{ question_id: string; voter_id: string; option_ids: string }>`
      SELECT question_id, voter_id, option_ids FROM room_vote
    `;
    for (const row of voteRows) {
      const question = this.getQuestion(row.question_id);
      if (!question || row.voter_id.length === 0) continue;

      let parsedSelection: unknown;
      try {
        parsedSelection = JSON.parse(row.option_ids);
      } catch {
        continue;
      }
      if (!Array.isArray(parsedSelection)) continue;

      const selection = sanitizeStoredSelection(question, parsedSelection);
      if (selection) this.getVotesForQuestion(question.id).set(row.voter_id, selection);
    }

    await this.refreshOptionImages();
    this.stateLoaded = true;
  }

  private ensureSchema() {
    this.sql`
      CREATE TABLE IF NOT EXISTS room_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS room_question (
        position INTEGER NOT NULL,
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS room_phase (
        question_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS room_vote (
        question_id TEXT NOT NULL,
        voter_id TEXT NOT NULL,
        option_ids TEXT NOT NULL,
        PRIMARY KEY (question_id, voter_id)
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS room_player (
        voter_id TEXT PRIMARY KEY,
        play_mode TEXT NOT NULL
      )
    `;
  }

  /**
   * First load only: seed the starter questions and carry over any session from the
   * old index-keyed tables (poll_room_*), which used the starter list's order.
   */
  private initializeQuestionsOnce() {
    const initialized = this.sql<{ value: string }>`
      SELECT value FROM room_meta WHERE key = 'questionsInitialized' LIMIT 1
    `;
    if (initialized.length > 0) return;

    STARTER_QUESTIONS.forEach((question, position) => {
      this.sql`
        INSERT OR REPLACE INTO room_question (position, id, data)
        VALUES (${position}, ${question.id}, ${JSON.stringify(question)})
      `;
    });

    const legacyTables = new Set(
      this.sql<{ name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('poll_room_meta', 'poll_room_phase', 'poll_room_vote')
      `.map((row) => row.name)
    );
    const idAtIndex = (index: number) => STARTER_QUESTIONS[index]?.id ?? null;

    if (legacyTables.has("poll_room_meta")) {
      const rows = this.sql<{ value: string }>`
        SELECT value FROM poll_room_meta WHERE key = 'currentQuestionIndex' LIMIT 1
      `;
      const questionId = idAtIndex(Number.parseInt(rows[0]?.value ?? "", 10));
      if (questionId) {
        this.sql`
          INSERT OR REPLACE INTO room_meta (key, value) VALUES ('currentQuestionId', ${questionId})
        `;
      }
      this.sql`DROP TABLE poll_room_meta`;
    }
    if (legacyTables.has("poll_room_phase")) {
      for (const row of this.sql<{ question_index: number; phase: string }>`
        SELECT question_index, phase FROM poll_room_phase
      `) {
        const questionId = idAtIndex(row.question_index);
        if (!questionId) continue;
        this.sql`
          INSERT OR REPLACE INTO room_phase (question_id, phase) VALUES (${questionId}, ${row.phase})
        `;
      }
      this.sql`DROP TABLE poll_room_phase`;
    }
    if (legacyTables.has("poll_room_vote")) {
      for (const row of this.sql<{ question_index: number; voter_id: string; option_ids: string }>`
        SELECT question_index, voter_id, option_ids FROM poll_room_vote
      `) {
        const questionId = idAtIndex(row.question_index);
        if (!questionId) continue;
        this.sql`
          INSERT OR REPLACE INTO room_vote (question_id, voter_id, option_ids)
          VALUES (${questionId}, ${row.voter_id}, ${row.option_ids})
        `;
      }
      this.sql`DROP TABLE poll_room_vote`;
    }

    this.sql`INSERT INTO room_meta (key, value) VALUES ('questionsInitialized', '1')`;
  }

  private persistCurrentQuestionId() {
    if (!this.currentQuestionId) {
      this.sql`DELETE FROM room_meta WHERE key = 'currentQuestionId'`;
      return;
    }
    this.sql`
      INSERT INTO room_meta (key, value)
      VALUES ('currentQuestionId', ${this.currentQuestionId})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `;
  }

  private setPhase(questionId: string, phase: PollPhase) {
    this.phaseByQuestionId.set(questionId, phase);
    this.sql`
      INSERT INTO room_phase (question_id, phase)
      VALUES (${questionId}, ${phase})
      ON CONFLICT(question_id) DO UPDATE SET phase = excluded.phase
    `;
  }

  private setPlayMode(voterId: string, playMode: PlayMode) {
    if (this.playModeByVoterId.get(voterId) === playMode) return;
    this.playModeByVoterId.set(voterId, playMode);
    this.sql`
      INSERT INTO room_player (voter_id, play_mode)
      VALUES (${voterId}, ${playMode})
      ON CONFLICT(voter_id) DO UPDATE SET play_mode = excluded.play_mode
    `;
  }

  private persistVote(questionId: string, voterId: string, optionIds: string[]) {
    if (optionIds.length === 0) {
      this.sql`
        DELETE FROM room_vote
        WHERE question_id = ${questionId} AND voter_id = ${voterId}
      `;
      return;
    }
    this.sql`
      INSERT INTO room_vote (question_id, voter_id, option_ids)
      VALUES (${questionId}, ${voterId}, ${JSON.stringify(optionIds)})
      ON CONFLICT(question_id, voter_id)
      DO UPDATE SET option_ids = excluded.option_ids
    `;
  }
}

/** Image option names can give the answer away, so they stay "Option A", "Option B", … until reveal. */
function toPublicQuestion(question: PollQuestion, canShowImageNames: boolean): PollQuestionPublic {
  if (question.kind === "choice") {
    const shouldHideLabels = question.display === "image" && !canShowImageNames;
    return {
      kind: "choice",
      id: question.id,
      prompt: question.prompt,
      allowMultiple: question.allowMultiple,
      hideResultsUntilReveal: question.hideResultsUntilReveal,
      display: question.display,
      options: question.options.map((option, index) =>
        shouldHideLabels ? { id: option.id, label: getOptionName(index) } : { ...option }
      ),
    };
  }
  return {
    kind: "number",
    id: question.id,
    prompt: question.prompt,
    min: question.min,
    max: question.max,
    step: question.step,
    hideResultsUntilReveal: question.hideResultsUntilReveal,
  };
}

function getVoteCounts(
  question: PollQuestion | null,
  votesForQuestion: Map<string, string[]>
): VoteCounts {
  if (!question || question.kind !== "choice") return {};

  const counts = getEmptyVoteCounts(question);
  for (const selectedOptionIds of votesForQuestion.values()) {
    for (const optionId of selectedOptionIds) {
      if (optionId in counts) counts[optionId] += 1;
    }
  }
  return counts;
}

function getEmptyVoteCounts(question: PollQuestion | null): VoteCounts {
  if (!question || question.kind !== "choice") return {};
  const counts: VoteCounts = {};
  for (const option of question.options) {
    counts[option.id] = 0;
  }
  return counts;
}

/** Re-checks a stored vote against the question as it is now; null when nothing valid is left. */
function sanitizeStoredSelection(question: PollQuestion, selection: unknown[]): string[] | null {
  if (question.kind === "number") {
    const guess = parseStoredNumberGuess(question, selection);
    return guess === null ? null : [String(guess)];
  }

  const allowedOptionIds = new Set(question.options.map((option) => option.id));
  const validOptionIds: string[] = [];
  for (const optionId of selection) {
    if (typeof optionId !== "string" || !allowedOptionIds.has(optionId)) continue;
    if (!validOptionIds.includes(optionId)) validOptionIds.push(optionId);
  }
  if (validOptionIds.length === 0) return null;
  if (!question.allowMultiple && validOptionIds.length > 1) return null;
  return validOptionIds;
}

function validateChoiceSelection(
  question: Extract<PollQuestion, { kind: "choice" }>,
  optionIds: string[]
): { ok: true; optionIds: string[] } | { ok: false; message: string } {
  if (!Array.isArray(optionIds) || optionIds.some((id) => typeof id !== "string")) {
    return { ok: false, message: "Vote payload must contain string option IDs." };
  }

  const allowedIds = new Set(question.options.map((option) => option.id));
  const deduped: string[] = [];

  for (const optionId of optionIds) {
    if (!allowedIds.has(optionId)) {
      return { ok: false, message: "Vote payload contains an invalid option ID." };
    }
    if (!deduped.includes(optionId)) deduped.push(optionId);
  }

  if (!question.allowMultiple && deduped.length > 1) {
    return { ok: false, message: "This question allows only one selected option." };
  }

  return { ok: true, optionIds: deduped };
}

function validateNumberGuess(
  question: Extract<PollQuestion, { kind: "number" }>,
  value: number | null
): { ok: true; value: number | null } | { ok: false; message: string } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, message: "Number guess must be a valid number." };
  }
  if (question.min !== undefined && value < question.min) {
    return { ok: false, message: `Guess must be at least ${question.min}.` };
  }
  if (question.max !== undefined && value > question.max) {
    return { ok: false, message: `Guess must be at most ${question.max}.` };
  }
  return { ok: true, value };
}

function isSelectionCorrect(selection: string[], correctOptionIds: string[]): boolean {
  if (selection.length !== correctOptionIds.length) return false;
  const selectedSet = new Set(selection);
  for (const correctOptionId of correctOptionIds) {
    if (!selectedSet.has(correctOptionId)) return false;
  }
  return true;
}

function parseStoredNumberGuess(
  question: Extract<PollQuestion, { kind: "number" }>,
  selection: string[] | unknown[]
): number | null {
  const firstValue = selection[0];
  const parsed = typeof firstValue === "number" ? firstValue : Number.parseFloat(String(firstValue));
  if (!Number.isFinite(parsed)) return null;
  if (question.min !== undefined && parsed < question.min) return null;
  if (question.max !== undefined && parsed > question.max) return null;
  return parsed;
}

function isPollPhase(value: string): value is PollPhase {
  return value === "idle" || value === "open" || value === "closed" || value === "revealed";
}

function getRole(role: string | null): PollRole {
  if (role === "host" || role === "projector") return role;
  return "audience";
}

function getSafeVoterId(voterId: string | null, fallback: string): string {
  if (voterId && /^[a-zA-Z0-9_-]{1,64}$/.test(voterId)) return voterId;
  return fallback;
}

function sanitizeAudienceName(name: string | null): string | null {
  if (!name) return null;
  const cleaned = name.replace(/\s+/g, " ").trim().slice(0, 80);
  return cleaned.length > 0 ? cleaned : null;
}

function isHostMessage(
  message: IncomingMessage
): message is Exclude<IncomingMessage, { type: "vote" | "vote-number" }> {
  return message.type !== "vote" && message.type !== "vote-number";
}

function parseIncomingMessage(rawMessage: string): IncomingMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;

  const message = parsed as Record<string, unknown>;
  if (typeof message.type !== "string") return null;

  switch (message.type) {
    case "vote":
      if (
        !Array.isArray(message.optionIds) ||
        message.optionIds.some((id) => typeof id !== "string")
      )
        return null;
      return { type: "vote", optionIds: message.optionIds };
    case "vote-number":
      if (message.value !== null && typeof message.value !== "number") return null;
      if (typeof message.value === "number" && !Number.isFinite(message.value)) return null;
      return { type: "vote-number", value: message.value as number | null };
    case "set-question":
      if (typeof message.questionIndex !== "number") return null;
      return { type: "set-question", questionIndex: message.questionIndex };
    case "open-voting":
    case "close-voting":
    case "reveal":
    case "reset-session":
      return { type: message.type };
    default:
      return null;
  }
}
