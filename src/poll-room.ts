import { Server } from "partyserver";
import type { Connection, ConnectionContext } from "partyserver";
import questionsData from "./data/questions";
import { loadOptionImages } from "./poll-images";
import { isPollImageId } from "./utils/poll-images";
import type {
  IncomingMessage,
  OutgoingMessage,
  PollChoiceDisplay,
  PollOptionImage,
  PollPhase,
  PollQuestion,
  PollQuestionPublic,
  PollRole,
  VoteCounts,
} from "./types";

type PollConnectionState = {
  role: PollRole;
  voterId: string | null;
  displayName: string | null;
};

export const QUESTIONS = validateQuestions(questionsData);

export class PollRoom extends Server<Env> {
  static options = { hibernate: true };

  private currentQuestionIndex = 0;
  private readonly phaseByQuestionIndex = new Map<number, PollPhase>();
  private readonly votesByQuestionIndex = new Map<number, Map<string, string[]>>();
  private optionImages: Record<string, PollOptionImage> = {};
  private stateLoaded = false;
  private loadStatePromise: Promise<void> | null = null;

  async onRequest(request: Request): Promise<Response> {
    await this.ensureStateLoaded();
    const url = new URL(request.url);

    if (url.pathname.endsWith("/images-changed") && request.method === "POST") {
      await this.refreshOptionImages();
      this.broadcastState();
      return Response.json({ ok: true });
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

      const questionStats: Array<{
        index: number;
        id: string;
        prompt: string;
        phase: string;
        totalVotes: number;
      }> = [];
      for (let i = 0; i < QUESTIONS.length; i++) {
        const q = QUESTIONS[i];
        const votes = this.votesByQuestionIndex.get(i);
        questionStats.push({
          index: i,
          id: q.id,
          prompt: q.prompt,
          phase: this.phaseByQuestionIndex.get(i) ?? "idle",
          totalVotes: votes?.size ?? 0,
        });
      }

      return Response.json({
        room: this.name,
        currentQuestionIndex: this.currentQuestionIndex,
        totalQuestions: QUESTIONS.length,
        participants: this.getConnectedParticipantCount(),
        audienceCount,
        hostCount,
        projectorCount,
        questions: questionStats,
      });
    }

    if (url.pathname.endsWith("/reset") && request.method === "POST") {
      this.currentQuestionIndex = 0;
      this.phaseByQuestionIndex.clear();
      this.votesByQuestionIndex.clear();
      await this.clearPersistedState();
      await this.refreshOptionImages();
      this.broadcastState();
      return Response.json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  }

  async onConnect(conn: Connection<PollConnectionState>, ctx: ConnectionContext) {
    await this.ensureStateLoaded();

    const url = new URL(ctx.request.url);
    const role = getRole(url.searchParams.get("role"));
    const voterId =
      role === "audience"
        ? getSafeVoterId(url.searchParams.get("voterId"), conn.id)
        : null;
    const displayName =
      role === "audience" ? sanitizeAudienceName(url.searchParams.get("name")) : null;

    conn.setState({ role, voterId, displayName });
    this.broadcastState();
  }

  async onMessage(
    conn: Connection<PollConnectionState>,
    message: string | ArrayBuffer | ArrayBufferView
  ) {
    await this.ensureStateLoaded();

    if (typeof message !== "string") return;

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

  onClose(
    _conn: Connection<PollConnectionState>,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): void {
    this.broadcastState();
  }

  onError(_conn: Connection<PollConnectionState>, _error: unknown): void {
    this.broadcastState();
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

    const validated = this.validateChoiceSelection(question, optionIds);
    if (validated.ok === false) {
      this.sendError(conn, validated.message);
      return;
    }

    const votesForQuestion = this.getVotesForQuestion(this.currentQuestionIndex);

    if (validated.optionIds.length === 0) {
      votesForQuestion.delete(conn.state.voterId);
    } else {
      votesForQuestion.set(conn.state.voterId, validated.optionIds);
    }

    await this.persistVote(this.currentQuestionIndex, conn.state.voterId, validated.optionIds);
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

    const validated = this.validateNumberGuess(question, value);
    if (validated.ok === false) {
      this.sendError(conn, validated.message);
      return;
    }

    const votesForQuestion = this.getVotesForQuestion(this.currentQuestionIndex);
    if (validated.value === null) {
      votesForQuestion.delete(conn.state.voterId);
      await this.persistVote(this.currentQuestionIndex, conn.state.voterId, []);
      this.broadcastState();
      return;
    }

    const storedSelection = [String(validated.value)];
    votesForQuestion.set(conn.state.voterId, storedSelection);
    await this.persistVote(this.currentQuestionIndex, conn.state.voterId, storedSelection);
    this.broadcastState();
  }

  private async handleHostCommand(
    message: Exclude<IncomingMessage, { type: "vote" | "vote-number" }>
  ) {
    switch (message.type) {
      case "set-question": {
        if (!Number.isInteger(message.questionIndex)) return;
        if (
          message.questionIndex < 0 ||
          message.questionIndex >= QUESTIONS.length
        )
          return;
        this.currentQuestionIndex = message.questionIndex;
        this.phaseByQuestionIndex.set(this.currentQuestionIndex, "open");
        await this.persistCurrentQuestionIndex();
        await this.persistPhase(this.currentQuestionIndex, "open");
        await this.refreshOptionImages();
        this.broadcastState();
        return;
      }
      case "open-voting": {
        this.phaseByQuestionIndex.set(this.currentQuestionIndex, "open");
        await this.persistPhase(this.currentQuestionIndex, "open");
        this.broadcastState();
        return;
      }
      case "close-voting": {
        this.phaseByQuestionIndex.set(this.currentQuestionIndex, "closed");
        await this.persistPhase(this.currentQuestionIndex, "closed");
        this.broadcastState();
        return;
      }
      case "reveal": {
        if (this.getCurrentPhase() === "open") {
          this.phaseByQuestionIndex.set(this.currentQuestionIndex, "closed");
          await this.persistPhase(this.currentQuestionIndex, "closed");
          this.broadcastState();
        }
        this.phaseByQuestionIndex.set(this.currentQuestionIndex, "revealed");
        await this.persistPhase(this.currentQuestionIndex, "revealed");
        this.broadcastState();
        return;
      }
      case "reset-session": {
        this.currentQuestionIndex = 0;
        this.phaseByQuestionIndex.clear();
        this.votesByQuestionIndex.clear();
        await this.clearPersistedState();
        await this.refreshOptionImages();
        this.broadcastState();
        return;
      }
    }
  }

  /** Best effort: a failed R2 read shows options without images rather than breaking the room. */
  private async refreshOptionImages() {
    try {
      this.optionImages = await loadOptionImages(this.env.POLL_IMAGES, this.getCurrentQuestion());
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
    } catch {
      // Connection may already be closed.
    }
  }

  private buildState(connection: Connection<PollConnectionState>): OutgoingMessage {
    const role = connection.state?.role ?? "audience";
    const voterId = connection.state?.voterId ?? null;
    const question = this.getCurrentQuestion();
    const phase = this.getCurrentPhase();
    const votesForQuestion = this.getVotesForQuestion(this.currentQuestionIndex);
    const questionPublic = question ? toPublicQuestion(question) : null;
    const resultsVisible = this.shouldShowResults(role, question);
    const voteCounts = resultsVisible
      ? this.getVoteCounts(question, votesForQuestion)
      : this.getEmptyVoteCounts(question);
    const yourSelection = role === "audience" && voterId ? (votesForQuestion.get(voterId) ?? []) : [];
    const yourVoteOptionIds =
      question?.kind === "choice" ? yourSelection : [];
    const yourNumberGuess =
      question?.kind === "number" ? parseStoredNumberGuess(question, yourSelection) : null;
    const canRevealCorrect = role === "host" || phase === "revealed";
    const winnerResult = question?.kind === "number" ? this.getNumberWinnerResult(question) : null;
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
              winningGuess: winnerResult?.winningGuess ?? null,
              winnerCount: winnerResult?.winnerCount ?? 0,
              isWinner:
                role === "audience"
                  ? winnerResult?.winningGuess !== null &&
                    yourNumberGuess !== null &&
                    yourNumberGuess === winnerResult?.winningGuess
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
      currentQuestionIndex: this.currentQuestionIndex,
      totalQuestions: QUESTIONS.length,
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
      host: role === "host" ? { questions: QUESTIONS } : null,
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

  private getCurrentQuestion(): PollQuestion | null {
    return QUESTIONS[this.currentQuestionIndex] ?? null;
  }

  private getVoteCounts(
    question: PollQuestion | null,
    votesForQuestion: Map<string, string[]>
  ): VoteCounts {
    if (!question || question.kind !== "choice") return {};

    const counts: VoteCounts = {};
    for (const option of question.options) {
      counts[option.id] = 0;
    }

    const allVotes = Array.from(votesForQuestion.values());
    for (let voteIndex = 0; voteIndex < allVotes.length; voteIndex += 1) {
      const selectedOptionIds = allVotes[voteIndex];
      for (let optionIndex = 0; optionIndex < selectedOptionIds.length; optionIndex += 1) {
        const optionId = selectedOptionIds[optionIndex];
        if (optionId in counts) {
          counts[optionId] += 1;
        }
      }
    }

    return counts;
  }

  private getEmptyVoteCounts(question: PollQuestion | null): VoteCounts {
    if (!question) return {};
    if (question.kind !== "choice") return {};
    const counts: VoteCounts = {};
    for (const option of question.options) {
      counts[option.id] = 0;
    }
    return counts;
  }

  private getNumberWinnerResult(question: Extract<PollQuestion, { kind: "number" }>): {
    winningGuess: number | null;
    winnerCount: number;
  } {
    return this.getNumberWinnerResultForQuestionIndex(this.currentQuestionIndex, question);
  }

  private getNumberWinnerResultForQuestionIndex(
    questionIndex: number,
    question: Extract<PollQuestion, { kind: "number" }>
  ): {
    winningGuess: number | null;
    winnerCount: number;
  } {
    const votesForQuestion = this.getVotesForQuestion(questionIndex);
    let winningGuess: number | null = null;
    let winnerCount = 0;

    const allSelections = Array.from(votesForQuestion.values());
    for (let index = 0; index < allSelections.length; index += 1) {
      const selection = allSelections[index];
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
    return this.phaseByQuestionIndex.get(this.currentQuestionIndex) ?? "idle";
  }

  private getVotesForQuestion(questionIndex: number): Map<string, string[]> {
    const existing = this.votesByQuestionIndex.get(questionIndex);
    if (existing) return existing;
    const created = new Map<string, string[]>();
    this.votesByQuestionIndex.set(questionIndex, created);
    return created;
  }

  private getScoreForVoter(voterId: string): {
    answered: number;
    correct: number;
    totalQuestions: number;
  } {
    let answered = 0;
    let correct = 0;

    for (let questionIndex = 0; questionIndex < QUESTIONS.length; questionIndex += 1) {
      const question = QUESTIONS[questionIndex];
      const votesForQuestion = this.votesByQuestionIndex.get(questionIndex);
      const selection = votesForQuestion?.get(voterId);
      if (!selection || selection.length === 0) continue;
      const phase = this.phaseByQuestionIndex.get(questionIndex) ?? "idle";

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
      if (phase === "revealed") {
        const winnerResult = this.getNumberWinnerResultForQuestionIndex(questionIndex, question);
        if (winnerResult.winningGuess !== null && guess === winnerResult.winningGuess) {
          correct += 1;
        }
      }
    }

    return {
      answered,
      correct,
      totalQuestions: QUESTIONS.length,
    };
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
    this.phaseByQuestionIndex.clear();
    this.votesByQuestionIndex.clear();
    this.currentQuestionIndex = 0;

    const metaRows = this.sql<{ value: string }>`
      SELECT value
      FROM poll_room_meta
      WHERE key = 'currentQuestionIndex'
      LIMIT 1
    `;
    const currentIndexRaw = metaRows[0]?.value;
    const parsedCurrentIndex = Number.parseInt(currentIndexRaw ?? "", 10);
    if (
      Number.isInteger(parsedCurrentIndex) &&
      parsedCurrentIndex >= 0 &&
      parsedCurrentIndex < QUESTIONS.length
    ) {
      this.currentQuestionIndex = parsedCurrentIndex;
    }

    const phaseRows = this.sql<{ question_index: number; phase: string }>`
      SELECT question_index, phase
      FROM poll_room_phase
    `;
    for (let index = 0; index < phaseRows.length; index += 1) {
      const row = phaseRows[index];
      if (!isValidQuestionIndex(row.question_index) || !isPollPhase(row.phase)) continue;
      this.phaseByQuestionIndex.set(row.question_index, row.phase);
    }

    const voteRows = this.sql<{
      question_index: number;
      voter_id: string;
      option_ids: string;
    }>`
      SELECT question_index, voter_id, option_ids
      FROM poll_room_vote
    `;
    for (let index = 0; index < voteRows.length; index += 1) {
      const row = voteRows[index];
      if (!isValidQuestionIndex(row.question_index) || row.voter_id.length === 0) continue;

      let parsedOptionIds: unknown;
      try {
        parsedOptionIds = JSON.parse(row.option_ids);
      } catch {
        continue;
      }
      if (!Array.isArray(parsedOptionIds)) continue;

      const question = QUESTIONS[row.question_index];
      if (question.kind === "choice") {
        const allowedOptionIds = new Set(question.options.map((option) => option.id));
        const validOptionIds: string[] = [];
        for (let optionIndex = 0; optionIndex < parsedOptionIds.length; optionIndex += 1) {
          const optionId = parsedOptionIds[optionIndex];
          if (typeof optionId !== "string" || !allowedOptionIds.has(optionId)) continue;
          if (!validOptionIds.includes(optionId)) validOptionIds.push(optionId);
        }
        if (!question.allowMultiple && validOptionIds.length > 1) continue;
        if (validOptionIds.length === 0) continue;

        const voteMap = this.getVotesForQuestion(row.question_index);
        voteMap.set(row.voter_id, validOptionIds);
        continue;
      }

      const restoredGuess = parseStoredNumberGuess(question, parsedOptionIds);
      if (restoredGuess === null) continue;
      const voteMap = this.getVotesForQuestion(row.question_index);
      voteMap.set(row.voter_id, [String(restoredGuess)]);
    }

    await this.refreshOptionImages();
    this.stateLoaded = true;
  }

  private ensureSchema() {
    this.sql`
      CREATE TABLE IF NOT EXISTS poll_room_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS poll_room_phase (
        question_index INTEGER PRIMARY KEY,
        phase TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS poll_room_vote (
        question_index INTEGER NOT NULL,
        voter_id TEXT NOT NULL,
        option_ids TEXT NOT NULL,
        PRIMARY KEY (question_index, voter_id)
      )
    `;
  }

  private async persistCurrentQuestionIndex() {
    this.sql`
      INSERT INTO poll_room_meta (key, value)
      VALUES ('currentQuestionIndex', ${String(this.currentQuestionIndex)})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `;
  }

  private async persistPhase(questionIndex: number, phase: PollPhase) {
    this.sql`
      INSERT INTO poll_room_phase (question_index, phase)
      VALUES (${questionIndex}, ${phase})
      ON CONFLICT(question_index) DO UPDATE SET phase = excluded.phase
    `;
  }

  private async persistVote(questionIndex: number, voterId: string, optionIds: string[]) {
    if (optionIds.length === 0) {
      this.sql`
        DELETE FROM poll_room_vote
        WHERE question_index = ${questionIndex} AND voter_id = ${voterId}
      `;
      return;
    }
    this.sql`
      INSERT INTO poll_room_vote (question_index, voter_id, option_ids)
      VALUES (${questionIndex}, ${voterId}, ${JSON.stringify(optionIds)})
      ON CONFLICT(question_index, voter_id)
      DO UPDATE SET option_ids = excluded.option_ids
    `;
  }

  private async clearPersistedState() {
    this.sql`DELETE FROM poll_room_vote`;
    this.sql`DELETE FROM poll_room_phase`;
    this.sql`DELETE FROM poll_room_meta`;
  }

  private validateChoiceSelection(
    question: Extract<PollQuestion, { kind: "choice" }>,
    optionIds: string[]
  ): { ok: true; optionIds: string[] } | { ok: false; message: string } {
    if (!Array.isArray(optionIds) || optionIds.some((id) => typeof id !== "string")) {
      return { ok: false, message: "Vote payload must contain string option IDs." };
    }

    const allowedIds = new Set(question.options.map((option) => option.id));
    const seen = new Set<string>();
    const deduped: string[] = [];

    for (const optionId of optionIds) {
      if (!allowedIds.has(optionId)) {
        return { ok: false, message: "Vote payload contains an invalid option ID." };
      }
      if (seen.has(optionId)) continue;
      seen.add(optionId);
      deduped.push(optionId);
    }

    if (!question.allowMultiple && deduped.length > 1) {
      return { ok: false, message: "This question allows only one selected option." };
    }

    return { ok: true, optionIds: deduped };
  }

  private validateNumberGuess(
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
}

function toPublicQuestion(question: PollQuestion): PollQuestionPublic {
  if (question.kind === "choice") {
    return {
      kind: "choice",
      id: question.id,
      prompt: question.prompt,
      allowMultiple: question.allowMultiple,
      hideResultsUntilReveal: question.hideResultsUntilReveal,
      display: question.display,
      options: question.options.map((option) => ({ ...option })),
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

function isValidQuestionIndex(questionIndex: number): boolean {
  return Number.isInteger(questionIndex) && questionIndex >= 0 && questionIndex < QUESTIONS.length;
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

function validateQuestions(rawQuestions: unknown): PollQuestion[] {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error("questions data module must export a non-empty array.");
  }

  const ids = new Set<string>();
  const validatedQuestions: PollQuestion[] = [];

  for (let index = 0; index < rawQuestions.length; index += 1) {
    const rawQuestion = rawQuestions[index];
    if (!rawQuestion || typeof rawQuestion !== "object") {
      throw new Error(`Question at index ${index} must be an object.`);
    }

    const question = rawQuestion as Record<string, unknown>;
    const id = question.id;
    const prompt = question.prompt;
    const kind = question.kind === "number" ? "number" : "choice";
    const hideResultsUntilReveal = question.hideResultsUntilReveal;

    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`Question at index ${index} has an invalid "id".`);
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate question id "${id}" found in questions data module.`);
    }
    ids.add(id);

    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error(`Question "${id}" has an invalid "prompt".`);
    }
    if (
      hideResultsUntilReveal !== undefined &&
      typeof hideResultsUntilReveal !== "boolean"
    ) {
      throw new Error(
        `Question "${id}" has invalid "hideResultsUntilReveal" (must be boolean).`
      );
    }

    if (kind === "number") {
      const correctNumber = question.correctNumber;
      const min = question.min;
      const max = question.max;
      const step = question.step;

      if (typeof correctNumber !== "number" || !Number.isFinite(correctNumber)) {
        throw new Error(`Question "${id}" must include numeric "correctNumber".`);
      }
      if (min !== undefined && (typeof min !== "number" || !Number.isFinite(min))) {
        throw new Error(`Question "${id}" has invalid "min".`);
      }
      if (max !== undefined && (typeof max !== "number" || !Number.isFinite(max))) {
        throw new Error(`Question "${id}" has invalid "max".`);
      }
      if (step !== undefined && (typeof step !== "number" || !Number.isFinite(step) || step <= 0)) {
        throw new Error(`Question "${id}" has invalid "step" (must be > 0).`);
      }
      if (min !== undefined && max !== undefined && min > max) {
        throw new Error(`Question "${id}" has min greater than max.`);
      }

      validatedQuestions.push({
        kind: "number",
        id,
        prompt,
        correctNumber,
        min: typeof min === "number" ? min : undefined,
        max: typeof max === "number" ? max : undefined,
        step: typeof step === "number" ? step : undefined,
        hideResultsUntilReveal: hideResultsUntilReveal === true,
      });
      continue;
    }

    const allowMultiple = question.allowMultiple;
    const options = question.options;
    const correctOptionIds = question.correctOptionIds;
    const display = parseChoiceDisplay(question.display, id);
    if (display === "image" && !isPollImageId(id)) {
      throw new Error(
        `Image question "${id}" needs an id of letters, numbers, "-" or "_" (max 64).`
      );
    }
    if (typeof allowMultiple !== "boolean") {
      throw new Error(`Question "${id}" must include boolean "allowMultiple".`);
    }
    if (!Array.isArray(options) || options.length < 2) {
      throw new Error(`Question "${id}" must include at least two options.`);
    }
    if (!Array.isArray(correctOptionIds) || correctOptionIds.length === 0) {
      throw new Error(`Question "${id}" must include one or more correctOptionIds.`);
    }

    const optionIds = new Set<string>();
    const validatedOptions = options.map((rawOption, optionIndex) => {
      if (!rawOption || typeof rawOption !== "object") {
        throw new Error(`Question "${id}" option at index ${optionIndex} must be an object.`);
      }
      const option = rawOption as Record<string, unknown>;
      if (typeof option.id !== "string" || option.id.length === 0) {
        throw new Error(`Question "${id}" has an option with invalid "id".`);
      }
      if (typeof option.label !== "string" || option.label.length === 0) {
        throw new Error(`Question "${id}" option "${option.id}" has invalid "label".`);
      }
      if (optionIds.has(option.id)) {
        throw new Error(`Question "${id}" has duplicate option id "${option.id}".`);
      }
      if (display === "image" && !isPollImageId(option.id)) {
        throw new Error(
          `Image question "${id}" option "${option.id}" needs an id of letters, numbers, "-" or "_".`
        );
      }
      optionIds.add(option.id);
      return { id: option.id, label: option.label };
    });

    const validatedCorrectOptionIds: string[] = [];
    const seenCorrect = new Set<string>();
    for (const rawCorrectOptionId of correctOptionIds) {
      if (typeof rawCorrectOptionId !== "string") {
        throw new Error(`Question "${id}" has non-string correctOptionIds entries.`);
      }
      if (!optionIds.has(rawCorrectOptionId)) {
        throw new Error(
          `Question "${id}" references unknown correct option "${rawCorrectOptionId}".`
        );
      }
      if (seenCorrect.has(rawCorrectOptionId)) continue;
      seenCorrect.add(rawCorrectOptionId);
      validatedCorrectOptionIds.push(rawCorrectOptionId);
    }

    if (!allowMultiple && validatedCorrectOptionIds.length > 1) {
      throw new Error(
        `Question "${id}" has multiple correct options but allowMultiple is false.`
      );
    }

    validatedQuestions.push({
      kind: "choice",
      id,
      prompt,
      allowMultiple,
      hideResultsUntilReveal: hideResultsUntilReveal === true,
      display,
      options: validatedOptions,
      correctOptionIds: validatedCorrectOptionIds,
    });
  }

  return validatedQuestions;
}

function parseChoiceDisplay(value: unknown, questionId: string): PollChoiceDisplay {
  if (value === undefined || value === "text") return "text";
  if (value === "image") return "image";
  throw new Error(`Question "${questionId}" has invalid "display" (use "text" or "image").`);
}
