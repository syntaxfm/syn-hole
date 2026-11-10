import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { FlowNumber as NumberFlow, type FlowNumberProps } from "~/components/flow-number";
import usePartySocket from "partysocket/react";
import {
  CheckCircle2,
  CheckCheck,
  Copy,
  Eye,
  Lock,
  Link2,
  LockKeyhole,
  MoreVertical,
  Maximize2,
  Rocket,
  Users,
} from "lucide-react";
import type {
  IncomingMessage,
  NumberWinner,
  OutgoingMessage,
  PlayMode,
  PollChoiceQuestion,
  PollChoiceQuestionPublic,
  PollNumberQuestion,
  PollNumberQuestionPublic,
  PollOptionImage,
  PollRole,
} from "~/types";
import {
  DEFAULT_PLAY_MODE,
  PLAY_MODES,
  PLAY_MODE_LABEL,
  getRoomSettingsEndpoint,
  parseRoomSettings,
  readPlayMode,
  savePlayMode,
} from "~/utils/play-mode";
import { isImageQuestion, isLandscapeImageSet } from "~/utils/poll-images";
import { getOptionName } from "~/utils/questions";
import { SyntaxHost } from "~/components/syntax-host";
import { SyntaxPlayer } from "~/components/syntax-player";
import type { SyntaxCommand, SyntaxOutgoingMessage, SyntaxStateMessage } from "~/syntax-game/protocol";

type ViewMode = "audience" | "host" | "projector";

const PARTY_NAME = "poll-room";
const DEFAULT_ROOM = "main-stage";
const VOTER_STORAGE_KEY = "syntax-live-poll-voter-id";
const AUDIENCE_NAME_STORAGE_KEY = "syntax-live-audience-name";
const HOST_KEY_STORAGE_KEY = "syntax-live-host-key";
const QUESTION_CROSS_SLIDE_MS = 320;

type StateMessage = Extract<OutgoingMessage, { type: "state" }>;

const phaseLabel: Record<string, string> = {
  idle: "Waiting to open voting",
  open: "Voting is open",
  closed: "Voting closed",
  revealed: "Answer revealed",
};

export function PollPage(props: { view: ViewMode; room?: string }) {
  const { view } = props;
  const room = props.room ?? DEFAULT_ROOM;
  const role: PollRole =
    view === "host"
      ? "host"
      : view === "projector"
        ? "projector"
        : "audience";

  const [showDebug, setShowDebug] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    const params = new URLSearchParams(window.location.search);
    setShowDebug(params.get("debug") === "1");
  }, []);

  // Browser credentials/identity are loaded after hydration, not during render.
  const [hostKey, setHostKey] = useState("");
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [numberGuessInput, setNumberGuessInput] = useState("");
  const [numberGuessError, setNumberGuessError] = useState<string | null>(null);
  const [status, setStatus] = useState("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syntaxState, setSyntaxState] = useState<SyntaxStateMessage | null>(null);
  const [lastSyntaxMessage, setLastSyntaxMessage] = useState<SyntaxOutgoingMessage | null>(null);
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const [hostPanel, setHostPanel] = useState<"poll" | "syntax">("poll");
  const syntaxActive = syntaxState?.mode === "syntax";
  const showSyntaxHost = view === "host" && (syntaxActive || hostPanel === "syntax");
  const previousSyntaxMode = useRef(syntaxState?.mode);
  useEffect(() => {
    if (previousSyntaxMode.current === "syntax" && syntaxState?.mode === "poll") setHostPanel("poll");
    previousSyntaxMode.current = syntaxState?.mode;
  }, [syntaxState?.mode]);
  const [stateMessage, setStateMessage] = useState<
    Extract<OutgoingMessage, { type: "state" }> | null
  >(null);
  const [roomStartAtMs, setRoomStartAtMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const audienceVoterId = useMemo(
    () => (role === "audience" ? getOrCreateVoterId() : ""),
    [role]
  );
  const [audienceName, setAudienceName] = useState("");
  const [pendingAudienceName, setPendingAudienceName] = useState(audienceName);
  const [askPlayModeBeforeJoin, setAskPlayModeBeforeJoin] = useState(false);
  const askPlayMode = role === "audience" && (stateMessage?.askPlayMode ?? askPlayModeBeforeJoin);
  const [playMode, setPlayMode] = useState<PlayMode | null>(null);
  const [pendingPlayMode, setPendingPlayMode] = useState<PlayMode>(playMode ?? DEFAULT_PLAY_MODE);
  useEffect(() => {
    if (role !== "audience") return;
    const name = readAudienceName();
    const mode = readPlayMode(room);
    setAudienceName(name);
    setPendingAudienceName(name);
    setPlayMode(mode);
    setPendingPlayMode(mode ?? DEFAULT_PLAY_MODE);
  }, [role, room]);
  const [isEditingIdentity, setIsEditingIdentity] = useState(false);
  const needsAudienceName = role === "audience" && audienceName.trim().length === 0;
  const showIdentityCheck =
    needsAudienceName || (askPlayMode && playMode === null) || isEditingIdentity;
  const canConnect =
    role === "host"
      ? hostKey.trim().length > 0
      : role === "audience"
        ? audienceName.trim().length > 0
        : true;

  // The socket keeps the query function from its first render, so it reads the latest values from here.
  const connectionQuery = useRef<Record<string, string | undefined>>({});
  connectionQuery.current = {
    role,
    voterId: role === "audience" ? audienceVoterId : undefined,
    name: role === "audience" ? audienceName : undefined,
    playMode: askPlayMode && playMode ? playMode : undefined,
    hostKey: role === "host" ? hostKey.trim() : undefined,
    syntaxProtocol: "1",
  };

  const socket = usePartySocket({
    enabled: canConnect,
    room,
    party: PARTY_NAME,
    query: () => connectionQuery.current,
    onOpen() {
      setStatus("connected");
      setErrorMessage(null);
    },
    onClose() {
      setStatus("disconnected");
    },
    onError() {
      setStatus("disconnected");
    },
    onMessage(event) {
      try {
        const message = JSON.parse(event.data as string) as OutgoingMessage | SyntaxOutgoingMessage;
        if (message.type.startsWith("syntax:")) {
          const syntaxMessage = message as SyntaxOutgoingMessage;
          setLastSyntaxMessage(syntaxMessage);
          if (syntaxMessage.type === "syntax:state") setSyntaxState(syntaxMessage);
          if (syntaxMessage.type === "syntax:error") setSyntaxError(syntaxMessage.message);
          return;
        }
        if (message.type === "error") {
          setErrorMessage(message.message);
          return;
        }
        setErrorMessage(null);
        if (message.type === "state") setStateMessage(message);
      } catch {
        setErrorMessage("Received malformed payload from server.");
      }
    },
  });

  const sendSyntaxCommand = useCallback((command: SyntaxCommand) => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Socket is not connected. Reconnect before retrying.");
    setSyntaxError(null);
    socket.send(JSON.stringify(command));
  }, [socket]);

  useEffect(() => {
    if (role !== "audience" || !stateMessage) {
      return;
    }
    if (stateMessage.question?.kind === "choice") {
      setSelectedOptionIds(stateMessage.yourVoteOptionIds);
      return;
    }
    setSelectedOptionIds([]);
    setNumberGuessInput(
      stateMessage.yourNumberGuess !== null ? String(stateMessage.yourNumberGuess) : ""
    );
  }, [role, stateMessage]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const urlHostKey = params.get("hostKey") ?? params.get("key");
    setHostKey(urlHostKey ?? readHostKey());
    if (urlHostKey) saveHostKey(urlHostKey);
  }, []);

  useEffect(() => {
    if (!hostKey.trim()) return;
    saveHostKey(hostKey.trim());
  }, [hostKey]);

  useEffect(() => {
    if (role !== "audience") return;
    let cancelled = false;
    fetch(getRoomSettingsEndpoint(room), { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const settings = parseRoomSettings(await response.json());
        if (!cancelled) setAskPlayModeBeforeJoin(settings.askPlayMode);
      })
      .catch((settingsError: unknown) => console.error("Failed to load room settings", settingsError));
    return () => {
      cancelled = true;
    };
  }, [role, room]);

  // A changed name or play mode only reaches the room on a fresh connection.
  const identityKey = `${audienceName}|${playMode ?? ""}|${role === "host" ? hostKey : ""}`;
  const connectedIdentityKey = useRef(identityKey);
  useEffect(() => {
    if (connectedIdentityKey.current === identityKey) return;
    connectedIdentityKey.current = identityKey;
    if (socket.readyState === WebSocket.OPEN) socket.reconnect();
  }, [identityKey, socket]);

  useEffect(() => {
    if (role !== "audience" || !needsAudienceName) return;

    let cancelled = false;

    void fetch("/api/bootstrap")
      .then(async (response) => {
        if (!response.ok) throw new Error("bootstrap request failed");
        return (await response.json()) as { defaultAudienceName?: unknown };
      })
      .then((data) => {
        if (cancelled) return;
        const suggested =
          typeof data.defaultAudienceName === "string" && data.defaultAudienceName.trim().length > 0
            ? data.defaultAudienceName
            : "Anon from somewhere";
        setPendingAudienceName((current) => (current.trim().length > 0 ? current : suggested));
      })
      .catch(() => {
        if (cancelled) return;
        setPendingAudienceName((current) =>
          current.trim().length > 0 ? current : "Anon from somewhere"
        );
      });

    return () => {
      cancelled = true;
    };
  }, [role, needsAudienceName]);

  const question = stateMessage?.question ?? null;
  const roomLinks = useMemo(() => getRoomLinks(room, hostKey.trim(), mounted), [room, hostKey, mounted]);
  const projectorFooterUrl = useMemo(
    () => (mounted && view === "projector" ? getAudienceQrDetails(roomLinks.audience).shortLink : ""),
    [roomLinks.audience, view, mounted]
  );
  const showStartingSoon =
    stateMessage !== null &&
    stateMessage.currentQuestionIndex === 0 &&
    stateMessage.phase === "idle";
  const msUntilRoomStart = roomStartAtMs === null ? null : roomStartAtMs - nowMs;

  useEffect(() => {
    let cancelled = false;

    async function refreshRoomStartTime() {
      try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/start-time`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { startAt?: unknown };
        const nextStartAtMs = parseRoomStartTimeMs(payload.startAt);
        if (!cancelled) setRoomStartAtMs(nextStartAtMs ?? null);
      } catch {
        if (!cancelled) setRoomStartAtMs(null);
      }
    }

    void refreshRoomStartTime();
    const refreshIntervalMs = showStartingSoon ? 10_000 : 60_000;
    const intervalId = window.setInterval(() => {
      void refreshRoomStartTime();
    }, refreshIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [room, showStartingSoon]);

  useEffect(() => {
    if (!showStartingSoon || roomStartAtMs === null) return;
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [showStartingSoon, roomStartAtMs]);

  function sendMessage(message: IncomingMessage) {
    if (syntaxActive) return;
    if (socket.readyState !== WebSocket.OPEN) {
      setErrorMessage("Socket is not connected yet.");
      return;
    }
    socket.send(JSON.stringify(message));
  }

  function onAudienceOptionToggle(optionId: string) {
    if (!question || question.kind !== "choice") return;
    let nextOptionIds: string[] = [];
    if (question.allowMultiple) {
      nextOptionIds = selectedOptionIds.includes(optionId)
        ? selectedOptionIds.filter((id) => id !== optionId)
        : [...selectedOptionIds, optionId];
      setSelectedOptionIds(nextOptionIds);
    } else {
      nextOptionIds = selectedOptionIds[0] === optionId ? [] : [optionId];
      setSelectedOptionIds(nextOptionIds);
    }
    sendMessage({ type: "vote", optionIds: nextOptionIds });
  }

  function onNumberGuessInputChange(value: string) {
    setNumberGuessInput(value);
    if (numberGuessError) setNumberGuessError(null);
  }

  function submitNumberGuess() {
    if (!question || question.kind !== "number") return;

    const trimmed = numberGuessInput.trim();
    if (trimmed.length === 0) {
      setNumberGuessError(null);
      sendMessage({ type: "vote-number", value: null });
      return;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setNumberGuessError("Enter a valid number.");
      return;
    }
    if (question.min !== undefined && parsed < question.min) {
      setNumberGuessError(`Enter a value of at least ${question.min}.`);
      return;
    }
    if (question.max !== undefined && parsed > question.max) {
      setNumberGuessError(`Enter a value of at most ${question.max}.`);
      return;
    }

    setNumberGuessError(null);
    sendMessage({ type: "vote-number", value: parsed });
  }

  function submitIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName =
      pendingAudienceName.replace(/\s+/g, " ").trim().slice(0, 80) || "Anon from somewhere";
    setAudienceName(nextName);
    setPendingAudienceName(nextName);
    saveAudienceName(nextName);
    if (askPlayMode) {
      setPlayMode(pendingPlayMode);
      savePlayMode(room, pendingPlayMode);
    }
    setIsEditingIdentity(false);
  }

  function editIdentity() {
    setPendingAudienceName(audienceName);
    setPendingPlayMode(playMode ?? DEFAULT_PLAY_MODE);
    setIsEditingIdentity(true);
  }

  return (
    <main className={`app app-${view} app-shell`}>
      {showIdentityCheck ? (
        <div className="name-overlay">
          <form className="name-modal" onSubmit={submitIdentity}>
            <span className="name-modal-kicker">Identity check</span>
            <h2>Ready to sync?</h2>
            <p className="muted">Enter your display name to join room {room}.</p>
            <input
              className="text-input"
              value={pendingAudienceName}
              onChange={(event) => setPendingAudienceName(event.currentTarget.value)}
              placeholder="Anon from somewhere"
              autoFocus
            />
            {askPlayMode ? (
              <fieldset className="play-mode-toggle" aria-label="Where are you playing?">
                {PLAY_MODES.map((mode) => (
                  <label key={mode}>
                    <input
                      type="radio"
                      name="playMode"
                      value={mode}
                      checked={pendingPlayMode === mode}
                      onChange={() => setPendingPlayMode(mode)}
                    />
                    {PLAY_MODE_LABEL[mode]}
                  </label>
                ))}
              </fieldset>
            ) : null}
            <button type="submit">Join Session</button>
          </form>
        </div>
      ) : null}

      {(stateMessage || errorMessage) && (!syntaxActive || errorMessage) ? (
        <header className={`header-panel header-panel-compact ${view === "projector" ? "header-panel-projector" : ""}`}>
          <div className="header-top header-top-compact">
            {stateMessage ? (
              <div className="header-live-stats header-live-stats-design">
                <span className="live-chip live-chip-connected live-chip-compact" title="Participants">
                  <Users size={13} strokeWidth={2} aria-hidden />
                  <strong>
                    <FlowInteger value={syntaxActive ? syntaxState.session?.participants ?? 0 : stateMessage.participants} />
                  </strong>
                </span>
                {askPlayMode && playMode ? (
                  <button
                    type="button"
                    className="live-chip live-chip-connected live-chip-compact play-mode-chip"
                    onClick={editIdentity}
                  >
                    {PLAY_MODE_LABEL[playMode]}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          {errorMessage ? <p className="error header-error">{errorMessage}</p> : null}
        </header>
      ) : null}

      {!stateMessage && !syntaxState ? (
        <section className="panel">
          <p className="muted">Connecting…</p>
        </section>
      ) : null}

      {syntaxActive && syntaxState && (view === "audience" || view === "projector") ? (
        <div className={view === "projector" ? "projector-shell" : undefined}>
          <SyntaxPlayer state={syntaxState} lastMessage={lastSyntaxMessage} connected={status === "connected"} view={view} send={sendSyntaxCommand} />
        </div>
      ) : null}

      {stateMessage && !syntaxActive && view === "audience" ? (
        showStartingSoon ? (
          <StartingSoonView
            stateMessage={stateMessage}
            audienceUrl={roomLinks.audience}
            room={room}
            roomStartAtMs={roomStartAtMs}
            msUntilRoomStart={msUntilRoomStart}
            view={view}
          />
        ) : (
          <AudienceView
            stateMessage={stateMessage}
            selectedOptionIds={selectedOptionIds}
            onToggleOption={onAudienceOptionToggle}
            numberGuessInput={numberGuessInput}
            numberGuessError={numberGuessError}
            onNumberGuessInputChange={onNumberGuessInputChange}
            onSubmitNumberGuess={submitNumberGuess}
          />
        )
      ) : null}

      {view === "host" ? <nav className="syntax-tool-group syntax-mode-switch" aria-label="Room mode">
        <button type="button" className="admin-action-btn" aria-pressed={!syntaxActive && hostPanel === "poll"} disabled={syntaxActive} onClick={() => setHostPanel("poll")}>Polls</button>
        <button type="button" className="admin-action-btn" aria-pressed={showSyntaxHost} onClick={() => setHostPanel("syntax")}>Spot the Syntax Error</button>
      </nav> : null}

      {view === "host" && (showSyntaxHost || !stateMessage) ? (
        <details className="syntax-details syntax-access" open={status !== "connected"}>
          <summary>Room access</summary>
          <label className="host-input-label">Host Access Key
            <input className="text-input" type="password" value={hostKey} onChange={(event) => setHostKey(event.currentTarget.value)} />
          </label>
          <p className="muted"><a href={roomLinks.audience}>Audience</a> · <a href={roomLinks.projector}>Projector</a> · <a href="/admin/syntax/">Screenshot library</a></p>
        </details>
      ) : null}

      {showSyntaxHost ? (
        <SyntaxHost room={room} hostKey={hostKey.trim()} state={syntaxState} connected={status === "connected"} send={sendSyntaxCommand} error={syntaxError} />
      ) : null}

      {stateMessage && !syntaxActive && view === "host" && hostPanel === "poll" ? (
        <HostView
          stateMessage={stateMessage}
          sendMessage={sendMessage}
          canControl={canConnect}
          hostKey={hostKey}
          onHostKeyChange={setHostKey}
          roomLinks={roomLinks}
        />
      ) : null}

      {stateMessage && !syntaxActive && view === "projector" ? (
        showStartingSoon ? (
          <StartingSoonView
            stateMessage={stateMessage}
            audienceUrl={roomLinks.audience}
            room={room}
            roomStartAtMs={roomStartAtMs}
            msUntilRoomStart={msUntilRoomStart}
            view={view}
          />
        ) : (
          <ProjectorView stateMessage={stateMessage} audienceUrl={roomLinks.audience} />
        )
      ) : null}

      <footer className="app-bottom-bar">
        <span className="app-bottom-left">SynHole</span>
        <div className="app-bottom-right">
          <span>Room: {room}</span>
          {!syntaxActive && <span>Role: {view}</span>}
          <span className="app-bottom-status">Status: {status}</span>
          {showDebug ? <span>debug</span> : null}
          {!syntaxActive && <span>Phase: {phaseLabel[stateMessage?.phase ?? "idle"] ?? "unknown"}</span>}
          {view === "projector" ? (
            <span className="projector-footer-url">{projectorFooterUrl}</span>
          ) : null}
        </div>
      </footer>
    </main>
  );
}

function AudienceView(props: {
  stateMessage: StateMessage;
  selectedOptionIds: string[];
  onToggleOption: (optionId: string) => void;
  numberGuessInput: string;
  numberGuessError: string | null;
  onNumberGuessInputChange: (value: string) => void;
  onSubmitNumberGuess: () => void;
}) {
  const {
    stateMessage,
    selectedOptionIds,
    onToggleOption,
    numberGuessInput,
    numberGuessError,
    onNumberGuessInputChange,
    onSubmitNumberGuess,
  } = props;
  const { displayedStateMessage, outgoingStateMessage, isAnimating } =
    useQuestionCrossSlideTransition(stateMessage);
  const question = displayedStateMessage.question;
  if (!question) {
    return (
      <section className="panel audience-panel">
        <h2>Audience</h2>
        <p className="muted">Host has not selected a question yet.</p>
      </section>
    );
  }

  const incoming = (
    <AudienceContent
      stateMessage={displayedStateMessage}
      selectedOptionIds={selectedOptionIds}
      onToggleOption={onToggleOption}
      numberGuessInput={numberGuessInput}
      numberGuessError={numberGuessError}
      onNumberGuessInputChange={onNumberGuessInputChange}
      onSubmitNumberGuess={onSubmitNumberGuess}
      interactive
    />
  );
  const outgoing =
    isAnimating && outgoingStateMessage?.question ? (
      <AudienceContent
        stateMessage={outgoingStateMessage}
        selectedOptionIds={outgoingStateMessage.yourVoteOptionIds}
        onToggleOption={onToggleOption}
        numberGuessInput={
          outgoingStateMessage.yourNumberGuess !== null ? String(outgoingStateMessage.yourNumberGuess) : ""
        }
        numberGuessError={null}
        onNumberGuessInputChange={onNumberGuessInputChange}
        onSubmitNumberGuess={onSubmitNumberGuess}
        interactive={false}
      />
    ) : null;

  return (
    <QuestionTransitionSlot
      className=""
      incoming={incoming}
      outgoing={outgoing}
      isAnimating={isAnimating}
    />
  );
}

function AudienceContent(props: {
  stateMessage: StateMessage;
  selectedOptionIds: string[];
  onToggleOption: (optionId: string) => void;
  numberGuessInput: string;
  numberGuessError: string | null;
  onNumberGuessInputChange: (value: string) => void;
  onSubmitNumberGuess: () => void;
  interactive: boolean;
}) {
  const {
    stateMessage,
    selectedOptionIds,
    onToggleOption,
    numberGuessInput,
    numberGuessError,
    onNumberGuessInputChange,
    onSubmitNumberGuess,
    interactive,
  } = props;
  const question = stateMessage.question;
  if (!question) return null;

  const votingOpen = stateMessage.phase === "open";
  const revealChoice = stateMessage.reveal?.kind === "choice" ? stateMessage.reveal : null;
  const canInteract = interactive && votingOpen;
  const resolvedNumberGuessInput =
    interactive || question.kind !== "number"
      ? numberGuessInput
      : stateMessage.yourNumberGuess !== null
        ? String(stateMessage.yourNumberGuess)
        : "";

  if (question.kind === "number") {
    return (
      <section className="audience-layout">
        <div className="audience-left">
          <div className="audience-meta-row u-inline-flex-center">
            <span className="question-pill">
              <QuestionCounter
                currentQuestionIndex={stateMessage.currentQuestionIndex}
                totalQuestions={stateMessage.totalQuestions}
              />
            </span>
            <span className={`audience-live-dot ${votingOpen ? "is-live" : ""}`}>
              {votingOpen ? "Live" : "Waiting"}
            </span>
            <span className="audience-answered-pill">
              <FlowInteger value={stateMessage.totalResponses} /> answered
            </span>
          </div>
          <h2 className="audience-hero">{question.prompt}</h2>
        </div>

        <div className="audience-right">
          <div className="panel audience-number-card">
            <div className="number-guess-row">
              <input
                type="number"
                className="text-input"
                min={question.min}
                max={question.max}
                step={question.step ?? 1}
                value={resolvedNumberGuessInput}
                onChange={(event) => {
                  if (!interactive) return;
                  onNumberGuessInputChange(event.currentTarget.value);
                }}
                placeholder="Enter your guess"
                disabled={!canInteract}
              />
              <button
                type="button"
                onClick={interactive ? onSubmitNumberGuess : undefined}
                disabled={!canInteract}
              >
                Save guess
              </button>
            </div>
            {interactive && numberGuessError ? <p className="error">{numberGuessError}</p> : null}
            <NumberResults
              question={question}
              reveal={stateMessage.reveal}
              totalResponses={stateMessage.totalResponses}
              showResults={stateMessage.resultsVisible}
              yourNumberGuess={stateMessage.yourNumberGuess}
            />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="audience-layout">
      <div className="audience-left">
        <div className="audience-meta-row u-inline-flex-center">
          <span className="question-pill">
            <QuestionCounter
              currentQuestionIndex={stateMessage.currentQuestionIndex}
              totalQuestions={stateMessage.totalQuestions}
            />
          </span>
          <span className={`audience-live-dot ${votingOpen ? "is-live" : ""}`}>
            {votingOpen ? "Live" : "Closed"}
          </span>
          <span className="audience-answered-pill">
            <FlowInteger value={stateMessage.totalResponses} /> answered
          </span>
        </div>
        <h2 className="audience-hero">{renderAudiencePrompt(question.prompt)}</h2>
      </div>

      <div className="audience-right">
        {isImageQuestion(question) ? (
          <AudienceImageOptions
            question={question}
            images={stateMessage.optionImages}
            voteCounts={stateMessage.voteCounts}
            totalResponses={stateMessage.totalResponses}
            selectedOptionIds={selectedOptionIds}
            revealCorrectOptionIds={revealChoice?.correctOptionIds ?? []}
            showResults={stateMessage.resultsVisible}
            canInteract={canInteract}
            onToggleOption={onToggleOption}
          />
        ) : (
          <AudienceChoiceOptions
            question={question}
            voteCounts={stateMessage.voteCounts}
            totalResponses={stateMessage.totalResponses}
            selectedOptionIds={selectedOptionIds}
            revealCorrectOptionIds={revealChoice?.correctOptionIds ?? []}
            showResults={stateMessage.resultsVisible}
            canInteract={canInteract}
            onToggleOption={onToggleOption}
          />
        )}
        <div className="audience-total-card">
          <FlowInteger value={stateMessage.totalResponses} /> total answers submitted
        </div>
      </div>
    </section>
  );
}

function StartingSoonView(props: {
  stateMessage: Extract<OutgoingMessage, { type: "state" }>;
  audienceUrl: string;
  room: string;
  roomStartAtMs: number | null;
  msUntilRoomStart: number | null;
  view: "audience" | "projector";
}) {
  const { stateMessage, audienceUrl, room, roomStartAtMs, msUntilRoomStart, view } = props;
  const { qrUrl, shortLink } = getAudienceQrDetails(audienceUrl);
  const rootDomain = getRootDomain(audienceUrl);
  const showCountdown =
    roomStartAtMs !== null && msUntilRoomStart !== null && msUntilRoomStart > 0;

  return (
    <section className="starting-soon-shell">
      <div className="starting-soon-grid">
        <div className="panel starting-soon-simple starting-soon-main" aria-live="polite">
          <span className="starting-soon-kicker">Room Lobby</span>
          <h2 className="starting-soon-main-timer">
            {showCountdown ? (
              <>
                STARTING IN <CountdownFlow milliseconds={msUntilRoomStart} />
              </>
            ) : (
              "STARTING SOON"
            )}
          </h2>
          {view === "audience" ? (
            <p className="starting-soon-note">Sit Tight!</p>
          ) : (
            <>
              <p className="starting-soon-info-line">
                <span>Go to</span>
                <strong>{rootDomain}</strong>
              </p>
              <p className="starting-soon-info-line">
                <span>Enter code</span>
                <strong>{room}</strong>
              </p>
            </>
          )}
          <div className="starting-soon-users">
            <small>Users currently in this room</small>
            <strong>
              <FlowInteger value={stateMessage.participants} />
            </strong>
          </div>
        </div>
        <aside className="projector-side">
          <div className="projector-qr-card starting-soon-qr-card">
            <img src={qrUrl} alt="Audience join QR code" className="projector-qr-image" />
            <p className="projector-qr-label">Join via QR or visit</p>
            <p className="projector-qr-link">{shortLink}</p>
          </div>
        </aside>
      </div>
    </section>
  );
}

function HostView(props: {
  stateMessage: Extract<OutgoingMessage, { type: "state" }>;
  sendMessage: (message: IncomingMessage) => void;
  canControl: boolean;
  hostKey: string;
  onHostKeyChange: (value: string) => void;
  roomLinks: ReturnType<typeof getRoomLinks>;
}) {
  const {
    stateMessage,
    sendMessage,
    canControl,
    hostKey,
    onHostKeyChange,
    roomLinks,
  } = props;
  const hostQuestions = stateMessage.host?.questions ?? [];
  const question = stateMessage.question;
  const hasNextQuestion = stateMessage.currentQuestionIndex < stateMessage.totalQuestions - 1;
  const smartNextAction = getSmartNextAction(stateMessage.phase, hasNextQuestion);
  const smartNextLabel = getSmartNextLabel(smartNextAction);
  const smartNextDescription = getSmartNextDescription(smartNextAction);
  const [copiedLink, setCopiedLink] = useState<"audience" | "projector" | "host" | null>(
    null
  );

  function runSmartNext() {
    switch (smartNextAction) {
      case "open":
        sendMessage({ type: "open-voting" });
        return;
      case "close":
        sendMessage({ type: "close-voting" });
        return;
      case "reveal":
        sendMessage({ type: "reveal" });
        return;
      case "switch":
        sendMessage({
          type: "set-question",
          questionIndex: stateMessage.currentQuestionIndex + 1,
        });
        return;
      case "none":
        return;
    }
  }

  function copyShareLink(
    target: "audience" | "projector" | "host",
    url: string
  ) {
    void navigator.clipboard.writeText(url).then(() => {
      setCopiedLink(target);
      window.setTimeout(() => {
        setCopiedLink((current) => (current === target ? null : current));
      }, 1200);
    });
  }

  return (
    <section className="host-layout">
      <div className="host-left-column">
        <section className="panel host-card">
          <div className="host-card-heading">
            <div>
              <h2>Control Panel</h2>
              <p className="muted">Manage room visibility and access</p>
            </div>
            <span className={`host-lock-chip ${canControl ? "host-lock-open" : "host-lock-closed"}`}>
              <LockKeyhole size={12} strokeWidth={2} aria-hidden />
              {canControl ? "Unlocked" : "Locked"}
            </span>
          </div>

          <label className="host-input-label">
            Host Access Key
            <div className="host-key-row">
              <input
                className="text-input"
                value={hostKey}
                onChange={(event) => onHostKeyChange(event.currentTarget.value)}
                placeholder="Host key"
                type="password"
              />
              <span className="host-key-eye" aria-hidden>
                <Eye size={15} strokeWidth={2} />
              </span>
            </div>
          </label>

          <div className="button-row">
            <button
              type="button"
              className="host-secondary-btn"
              onClick={() => sendMessage({ type: "close-voting" })}
              disabled={!canControl}
            >
              <Lock size={14} strokeWidth={2} aria-hidden />
              Lock Room
            </button>
          </div>
        </section>

        <section className="panel host-card">
          <div className="host-card-heading">
            <div>
              <h3>Active Question</h3>
              <p className="muted">Select and launch polling phases</p>
            </div>
          </div>

          <label className="host-input-label">
            Select Question
            <select
              value={stateMessage.currentQuestionIndex}
              onChange={(event) =>
                sendMessage({
                  type: "set-question",
                  questionIndex: Number(event.currentTarget.value),
                })
              }
              disabled={!canControl}
            >
              {hostQuestions.map((item, index) => (
                <option key={item.id} value={index}>
                  Q{index + 1}: {item.prompt}
                </option>
              ))}
            </select>
          </label>

          <div className="host-next-phase-card">
            <span>Next Phase</span>
            <p>{smartNextLabel}</p>
            <small>{smartNextDescription}</small>
          </div>

          <button
            type="button"
            className="host-launch-btn"
            onClick={runSmartNext}
            disabled={!canControl || smartNextAction === "none"}
          >
            Next: {smartNextLabel}
            <Rocket size={15} strokeWidth={2} aria-hidden />
          </button>

          <div className="host-manual-row">
            <button onClick={() => sendMessage({ type: "open-voting" })} disabled={!canControl}>
              Open
            </button>
            <button onClick={() => sendMessage({ type: "close-voting" })} disabled={!canControl}>
              Close
            </button>
            <button onClick={() => sendMessage({ type: "reveal" })} disabled={!canControl}>
              Reveal
            </button>
            <button onClick={() => sendMessage({ type: "reset-session" })} disabled={!canControl}>
              Reset
            </button>
          </div>
        </section>

        <section className="panel nested-panel share-links-panel">
          <h3>Share Links</h3>
          <div className="link-rows">
            <div className="link-row">
              <span className="link-row-label u-inline-flex-center">
                <Link2 size={14} strokeWidth={2} aria-hidden />
                Audience
              </span>
              <div className="link-row-actions">
                <a href={roomLinks.audience} target="_blank" rel="noreferrer">
                  Open
                </a>
                <button
                  className="copy-link-btn"
                  onClick={() => copyShareLink("audience", roomLinks.audience)}
                  type="button"
                >
                  {copiedLink === "audience" ? (
                    <CheckCheck size={14} strokeWidth={2} aria-hidden />
                  ) : (
                    <Copy size={14} strokeWidth={2} aria-hidden />
                  )}
                </button>
              </div>
            </div>
            <div className="link-row">
              <span className="link-row-label u-inline-flex-center">
                <Link2 size={14} strokeWidth={2} aria-hidden />
                Projector
              </span>
              <div className="link-row-actions">
                <a href={roomLinks.projector} target="_blank" rel="noreferrer">
                  Open
                </a>
                <button
                  className="copy-link-btn"
                  onClick={() => copyShareLink("projector", roomLinks.projector)}
                  type="button"
                >
                  {copiedLink === "projector" ? (
                    <CheckCheck size={14} strokeWidth={2} aria-hidden />
                  ) : (
                    <Copy size={14} strokeWidth={2} aria-hidden />
                  )}
                </button>
              </div>
            </div>
            <div className="link-row">
              <span className="link-row-label u-inline-flex-center">
                <Link2 size={14} strokeWidth={2} aria-hidden />
                Host
              </span>
              <div className="link-row-actions">
                <a href={roomLinks.host} target="_blank" rel="noreferrer">
                  Open
                </a>
                <button
                  className="copy-link-btn"
                  onClick={() => copyShareLink("host", roomLinks.host)}
                  type="button"
                >
                  {copiedLink === "host" ? (
                    <CheckCheck size={14} strokeWidth={2} aria-hidden />
                  ) : (
                    <Copy size={14} strokeWidth={2} aria-hidden />
                  )}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="host-preview-card">
        <div className="host-preview-top">
          <span>Live Results Preview</span>
          <div className="host-preview-actions" aria-hidden>
            <Maximize2 size={14} strokeWidth={2} />
            <MoreVertical size={14} strokeWidth={2} />
          </div>
        </div>

        <span className="host-preview-question-count">
          Question <FlowInteger value={stateMessage.currentQuestionIndex + 1} /> of{" "}
          <FlowInteger value={stateMessage.totalQuestions} />
        </span>
        <h3>{question ? question.prompt : "Waiting for question"}</h3>

        {question ? (
          question.kind === "number" ? (
            <NumberResults
              question={question}
              reveal={stateMessage.reveal}
              totalResponses={stateMessage.totalResponses}
              showResults={stateMessage.resultsVisible}
              yourNumberGuess={null}
            />
          ) : (
            isImageQuestion(question) ? (
              <HostPreviewImageResults
                question={question}
                images={stateMessage.optionImages}
                voteCounts={stateMessage.voteCounts}
                totalResponses={stateMessage.totalResponses}
                showResults={stateMessage.resultsVisible}
                correctOptionIds={
                  stateMessage.reveal?.kind === "choice" ? stateMessage.reveal.correctOptionIds : []
                }
              />
            ) : (
              <HostPreviewChoiceResults
                question={question}
                voteCounts={stateMessage.voteCounts}
                totalResponses={stateMessage.totalResponses}
                showResults={stateMessage.resultsVisible}
              />
            )
          )
        ) : null}

        <div className="host-preview-bottom">
          <div className="host-preview-stat">
            <small>Confidence</small>
            <strong>{getConfidenceLabel(stateMessage.totalResponses, stateMessage.participants)}</strong>
          </div>
          <div className="host-preview-stat">
            <small>Active users</small>
            <strong>
              <FlowInteger value={stateMessage.totalResponses} />/
              <FlowInteger value={Math.max(1, stateMessage.participants)} />
            </strong>
          </div>
          <span className="host-preview-phase">
            Phase: {phaseLabel[stateMessage.phase] ?? stateMessage.phase}
          </span>
        </div>
      </div>
    </section>
  );
}

function ProjectorView(props: {
  stateMessage: StateMessage;
  audienceUrl: string;
}) {
  const { stateMessage, audienceUrl } = props;
  const { displayedStateMessage, outgoingStateMessage, isAnimating } =
    useQuestionCrossSlideTransition(stateMessage);
  const question = displayedStateMessage.question;

  if (!question) {
    return (
      <section className="projector-shell">
        <h2>Projector</h2>
        <p className="muted">Waiting for host to select a question.</p>
      </section>
    );
  }

  const { qrUrl, shortLink } = getAudienceQrDetails(audienceUrl);
  const outgoingQuestion = outgoingStateMessage?.question;

  return (
    <section className="projector-shell">
      <QuestionTransitionSlot
        className="projector-head"
        isAnimating={isAnimating}
        incoming={<ProjectorHeadContent stateMessage={displayedStateMessage} />}
        outgoing={
          outgoingQuestion ? <ProjectorHeadContent stateMessage={outgoingStateMessage} /> : null
        }
      />

      <div className="projector-main-grid">
        <QuestionTransitionSlot
          className="projector-main-left"
          isAnimating={isAnimating}
          incoming={<ProjectorMainContent stateMessage={displayedStateMessage} />}
          outgoing={
            outgoingQuestion ? <ProjectorMainContent stateMessage={outgoingStateMessage} /> : null
          }
        />

        <aside className="projector-side">
          <div className="projector-qr-card">
            <img src={qrUrl} alt="Audience join QR code" className="projector-qr-image" />
            <p className="projector-qr-label">Join via QR or visit</p>
            <p className="projector-qr-link">{shortLink}</p>
          </div>
        </aside>
      </div>
    </section>
  );
}

function ProjectorHeadContent(props: { stateMessage: StateMessage }) {
  const { stateMessage } = props;
  const question = stateMessage.question;
  if (!question) return null;
  return (
    <>
      <div className="projector-meta-row u-inline-flex-center">
        <span className="projector-kicker">Current Question</span>
        <span className="projector-answered-pill">
          <FlowInteger value={stateMessage.totalResponses} /> answered
        </span>
      </div>
      <h2 className="projector-title">{question.prompt}</h2>
    </>
  );
}

function ProjectorMainContent(props: { stateMessage: StateMessage }) {
  const { stateMessage } = props;
  const question = stateMessage.question;
  if (!question) return null;
  const revealChoice = stateMessage.reveal?.kind === "choice" ? stateMessage.reveal : null;
  if (isImageQuestion(question)) {
    return (
      <ProjectorImageResults
        question={question}
        images={stateMessage.optionImages}
        voteCounts={stateMessage.voteCounts}
        totalResponses={stateMessage.totalResponses}
        showResults={stateMessage.resultsVisible}
        revealCorrectOptionIds={revealChoice?.correctOptionIds ?? []}
      />
    );
  }
  return question.kind === "number" ? (
    <NumberResults
      question={question}
      reveal={stateMessage.reveal}
      totalResponses={stateMessage.totalResponses}
      showResults={stateMessage.resultsVisible}
      yourNumberGuess={null}
    />
  ) : (
    <ProjectorChoiceResults
      question={question}
      voteCounts={stateMessage.voteCounts}
      totalResponses={stateMessage.totalResponses}
      showResults={stateMessage.resultsVisible}
      revealCorrectOptionIds={revealChoice?.correctOptionIds ?? []}
    />
  );
}

function QuestionTransitionSlot(props: {
  className: string;
  isAnimating: boolean;
  incoming: ReactNode;
  outgoing: ReactNode | null;
}) {
  const { className, isAnimating, incoming, outgoing } = props;
  if (!isAnimating || !outgoing) {
    if (className.trim().length === 0) return <>{incoming}</>;
    return <div className={className}>{incoming}</div>;
  }
  const stackClassName =
    className.trim().length > 0 ? `${className} question-transition-stack` : "question-transition-stack";
  return (
    <div className={stackClassName}>
      <div className="question-transition-layer question-transition-layer-out">{outgoing}</div>
      <div className="question-transition-layer question-transition-layer-in">{incoming}</div>
    </div>
  );
}

function ProjectorChoiceResults(props: {
  question: PollChoiceQuestionPublic | PollChoiceQuestion;
  voteCounts: Record<string, number>;
  totalResponses: number;
  showResults: boolean;
  revealCorrectOptionIds: string[];
}) {
  const { question, voteCounts, totalResponses, showResults, revealCorrectOptionIds } = props;
  const denominator = Math.max(1, totalResponses);
  const maxVotes = Math.max(...question.options.map((option) => voteCounts[option.id] ?? 0), 0);

  return (
    <div className="projector-choice-results">
      {question.options.map((option, index) => {
        const votes = voteCounts[option.id] ?? 0;
        const percent = showResults ? Math.round((votes / denominator) * 100) : 0;
        const isLeading = votes > 0 && votes === maxVotes;
        const isWinner = revealCorrectOptionIds.includes(option.id);

        return (
          <div className="projector-bar-row" key={option.id}>
            <div className="projector-bar-topline">
              <span className={`projector-bar-label ${isWinner ? "is-correct" : ""}`}>{option.label}</span>
              <span>
                {showResults ? (
                  <>
                    <FlowInteger value={percent} />% (<FlowInteger value={votes} />)
                  </>
                ) : (
                  "--"
                )}
              </span>
            </div>
            <div className="projector-bar-track">
              <div
                className={`projector-bar-fill ${isLeading ? "is-leading" : ""}`}
                style={{ width: `${percent}%` }}
              >
                <span className="projector-bar-icon">{String.fromCharCode(97 + (index % 26))}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AudienceChoiceOptions(props: {
  question: PollChoiceQuestionPublic | PollChoiceQuestion;
  voteCounts: Record<string, number>;
  totalResponses: number;
  selectedOptionIds: string[];
  revealCorrectOptionIds: string[];
  showResults: boolean;
  canInteract: boolean;
  onToggleOption: (optionId: string) => void;
}) {
  const {
    question,
    voteCounts,
    totalResponses,
    selectedOptionIds,
    revealCorrectOptionIds,
    showResults,
    canInteract,
    onToggleOption,
  } = props;
  const denominator = Math.max(1, totalResponses);

  return (
    <div className="audience-choice-list">
      {question.options.map((option, index) => {
        const votes = voteCounts[option.id] ?? 0;
        const percent = Math.round((votes / denominator) * 100);
        const checked = selectedOptionIds.includes(option.id);
        const isCorrectOption = revealCorrectOptionIds.includes(option.id);
        const feedback =
          revealCorrectOptionIds.length > 0 ? getAudienceOptionFeedback(checked, isCorrectOption) : null;
        const feedbackLabel = feedback === "missed-correct" ? "Correct" : feedback ? "Your choice" : null;
        return (
          <button
            type="button"
            key={option.id}
            className={`audience-option-card ${checked ? "is-selected" : ""} ${
              feedback ? `feedback-${feedback}` : ""
            } ${!canInteract ? "is-locked" : ""}`}
            onClick={() => onToggleOption(option.id)}
            disabled={!canInteract}
          >
            <div className="audience-option-left">
              <small>Option {String.fromCharCode(65 + (index % 26))}</small>
              <strong>{option.label}</strong>
            </div>
            <div className="audience-option-right">
              {showResults ? (
                <span>
                  <FlowInteger value={percent} />%
                </span>
              ) : null}
              {feedback === "selected-correct" || feedback === "missed-correct" ? (
                <CheckCircle2 size={16} strokeWidth={2.2} aria-hidden />
              ) : null}
              {feedbackLabel ? (
                <span className={`audience-option-badge badge-${feedback}`}>{feedbackLabel}</span>
              ) : null}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function HostPreviewChoiceResults(props: {
  question: PollChoiceQuestionPublic | PollChoiceQuestion;
  voteCounts: Record<string, number>;
  totalResponses: number;
  showResults: boolean;
}) {
  const { question, voteCounts, totalResponses, showResults } = props;
  const denominator = Math.max(1, totalResponses);
  const maxVotes = Math.max(...question.options.map((option) => voteCounts[option.id] ?? 0), 0);

  return (
    <div className="host-preview-results">
      {question.options.map((option) => {
        const votes = voteCounts[option.id] ?? 0;
        const percent = Math.round((votes / denominator) * 100);
        const leading = votes > 0 && votes === maxVotes;
        return (
          <div className="host-preview-result-row" key={option.id}>
            <div className="host-preview-result-top">
              <span>{option.label}</span>
              <span>
                {showResults ? (
                  <>
                    <FlowInteger value={votes} /> votes (<FlowInteger value={percent} />%)
                  </>
                ) : (
                  "--"
                )}
              </span>
            </div>
            <div className="host-preview-result-track">
              <div
                className={`host-preview-result-fill ${leading ? "is-leading" : ""}`}
                style={{ width: `${showResults ? percent : 0}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function OptionImage(props: { image: PollOptionImage | undefined; label: string }) {
  const { image, label } = props;
  if (!image) return <span className="poll-image-missing">{label}</span>;
  return (
    <img src={image.url} width={image.width} height={image.height} alt={label} decoding="async" />
  );
}

function AudienceImageOptions(props: {
  question: PollChoiceQuestionPublic | PollChoiceQuestion;
  images: Record<string, PollOptionImage>;
  voteCounts: Record<string, number>;
  totalResponses: number;
  selectedOptionIds: string[];
  revealCorrectOptionIds: string[];
  showResults: boolean;
  canInteract: boolean;
  onToggleOption: (optionId: string) => void;
}) {
  const {
    question,
    images,
    voteCounts,
    totalResponses,
    selectedOptionIds,
    revealCorrectOptionIds,
    showResults,
    canInteract,
    onToggleOption,
  } = props;
  const denominator = Math.max(1, totalResponses);
  const isRevealed = revealCorrectOptionIds.length > 0;
  const isLandscape = isLandscapeImageSet(Object.values(images));

  return (
    <div className={`audience-image-grid ${isLandscape ? "is-landscape" : ""}`}>
      {question.options.map((option, index) => {
        const votes = voteCounts[option.id] ?? 0;
        const percent = Math.round((votes / denominator) * 100);
        const checked = selectedOptionIds.includes(option.id);
        const isCorrectOption = revealCorrectOptionIds.includes(option.id);
        const feedback = isRevealed ? getAudienceOptionFeedback(checked, isCorrectOption) : null;
        return (
          <button
            type="button"
            key={option.id}
            className={`audience-image-card ${checked ? "is-selected" : ""} ${
              isRevealed && !isCorrectOption ? "is-faded" : ""
            } ${feedback ? `feedback-${feedback}` : ""}`}
            onClick={() => onToggleOption(option.id)}
            disabled={!canInteract}
          >
            <OptionImage image={images[option.id]} label={option.label} />
            <span className="audience-image-meta">
              <span className="audience-option-left">
                <small>{isRevealed ? getOptionName(index) : "Option"}</small>
                <strong>{isRevealed ? option.label : String.fromCharCode(65 + (index % 26))}</strong>
              </span>
              <span className="audience-option-right">
                {showResults ? (
                  <span>
                    <FlowInteger value={percent} />%
                  </span>
                ) : null}
                {feedback === "selected-correct" ? (
                  <CheckCircle2 size={16} strokeWidth={2.2} aria-label="Correct" />
                ) : null}
                {feedback === "missed-correct" ? (
                  <span className="audience-option-badge badge-missed-correct">Correct</span>
                ) : null}
                {feedback === "selected-wrong" ? (
                  <span className="audience-option-badge badge-selected-wrong">Your choice</span>
                ) : null}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ProjectorImageResults(props: {
  question: PollChoiceQuestionPublic | PollChoiceQuestion;
  images: Record<string, PollOptionImage>;
  voteCounts: Record<string, number>;
  totalResponses: number;
  showResults: boolean;
  revealCorrectOptionIds: string[];
}) {
  const { question, images, voteCounts, totalResponses, showResults, revealCorrectOptionIds } =
    props;
  const denominator = Math.max(1, totalResponses);
  const maxVotes = Math.max(...question.options.map((option) => voteCounts[option.id] ?? 0), 0);
  const isRevealed = revealCorrectOptionIds.length > 0;

  return (
    <div className="projector-image-results">
      {question.options.map((option, index) => {
        const votes = voteCounts[option.id] ?? 0;
        const percent = showResults ? Math.round((votes / denominator) * 100) : 0;
        const isLeading = votes > 0 && votes === maxVotes;
        const isWinner = revealCorrectOptionIds.includes(option.id);

        return (
          <div
            className={`projector-image-option ${isRevealed && !isWinner ? "is-faded" : ""}`}
            key={option.id}
          >
            <div className="projector-bar-topline">
              <span className={`projector-bar-label ${isWinner ? "is-correct" : ""}`}>
                {isRevealed ? `${getOptionName(index)} · ${option.label}` : getOptionName(index)}
              </span>
              <span>
                {showResults ? (
                  <>
                    <FlowInteger value={percent} />% (<FlowInteger value={votes} />)
                  </>
                ) : (
                  "--"
                )}
              </span>
            </div>
            <div className="projector-image-stack">
              <OptionImage image={images[option.id]} label={option.label} />
              <div className="projector-bar-track">
                <div
                  className={`projector-bar-fill ${isLeading ? "is-leading" : ""}`}
                  style={{ width: `${percent}%` }}
                >
                  <span className="projector-bar-icon">{String.fromCharCode(97 + (index % 26))}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HostPreviewImageResults(props: {
  question: PollChoiceQuestionPublic | PollChoiceQuestion;
  images: Record<string, PollOptionImage>;
  voteCounts: Record<string, number>;
  totalResponses: number;
  showResults: boolean;
  correctOptionIds: string[];
}) {
  const { question, images, voteCounts, totalResponses, showResults, correctOptionIds } = props;
  const denominator = Math.max(1, totalResponses);
  const maxVotes = Math.max(...question.options.map((option) => voteCounts[option.id] ?? 0), 0);

  return (
    <div className="host-preview-image-results">
      {question.options.map((option, index) => {
        const votes = voteCounts[option.id] ?? 0;
        const percent = Math.round((votes / denominator) * 100);
        const leading = votes > 0 && votes === maxVotes;
        const isCorrect = correctOptionIds.includes(option.id);
        return (
          <div className={`host-preview-image-option ${isCorrect ? "is-correct" : ""}`} key={option.id}>
            <OptionImage image={images[option.id]} label={option.label} />
            <div className="host-preview-result-top">
              <span>
                {getOptionName(index)} · {option.label}
                {isCorrect ? " ✓" : ""}
              </span>
              <span>
                {showResults ? (
                  <>
                    <FlowInteger value={votes} /> votes (<FlowInteger value={percent} />%)
                  </>
                ) : (
                  "--"
                )}
              </span>
            </div>
            <div className="host-preview-result-track">
              <div
                className={`host-preview-result-fill ${leading ? "is-leading" : ""}`}
                style={{ width: `${showResults ? percent : 0}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function renderAudiencePrompt(prompt: string) {
  const words = prompt.trim().split(/\s+/);
  if (words.length < 2) {
    return prompt;
  }
  const last = words[words.length - 1];
  const head = words.slice(0, -1).join(" ");
  return (
    <>
      {head} <span className="audience-prompt-accent">{last}</span>
    </>
  );
}

function ResultsList(props: {
  question: PollChoiceQuestionPublic | PollChoiceQuestion;
  voteCounts: Record<string, number>;
  totalResponses: number;
  revealCorrectOptionIds: string[];
  showResults: boolean;
  showOptionsWhenHidden?: boolean;
  selectable?: boolean;
  selectedOptionIds?: string[];
  inputType?: "checkbox" | "radio";
  selectionName?: string;
  canInteract?: boolean;
  onToggleOption?: (optionId: string) => void;
  showAudienceFeedback?: boolean;
}) {
  const {
    question,
    voteCounts,
    totalResponses,
    revealCorrectOptionIds,
    showResults,
    showOptionsWhenHidden = false,
    selectable = false,
    selectedOptionIds = [],
    inputType = "radio",
    selectionName = "poll-option",
    canInteract = false,
    onToggleOption,
    showAudienceFeedback = false,
  } = props;
  if (!showResults && !showOptionsWhenHidden) {
    return <p className="muted">Results are hidden until reveal.</p>;
  }
  const denominator = Math.max(1, totalResponses);

  return (
    <div className="results">
      {question.options.map((option, optionIndex) => {
        const votes = voteCounts[option.id] ?? 0;
        const percent = showResults ? Math.round((votes / denominator) * 100) : 0;
        const isCorrect = revealCorrectOptionIds.includes(option.id);
        const checked = selectedOptionIds.includes(option.id);
        const isInteractive = selectable && typeof onToggleOption === "function";
        const feedback =
          showAudienceFeedback && revealCorrectOptionIds.length > 0
            ? getAudienceOptionFeedback(checked, isCorrect)
            : null;
        return (
          <label
            className={`result-row ${isCorrect ? "correct" : ""} ${
              isInteractive ? "result-row-interactive" : ""
            } ${feedback ? `feedback-${feedback}` : ""} ${checked ? "row-selected" : ""}`}
            key={option.id}
          >
            {isInteractive ? (
              <input
                type={inputType}
                checked={checked}
                name={selectionName}
                onChange={() => onToggleOption(option.id)}
                disabled={!canInteract}
              />
            ) : null}
            <div className="result-content">
              <div className="result-meta">
                <span className="result-label-wrap">
                  <span className="option-index">
                    {String.fromCharCode(65 + (optionIndex % 26))}
                  </span>
                  <span>{option.label}</span>
                  {feedback ? (
                    <span className={`result-feedback-chip feedback-chip-${feedback}`}>
                      {feedback === "missed-correct" ? "Correct" : "Your choice"}
                    </span>
                  ) : null}
                </span>
                <span>
                  {showResults ? (
                    <>
                      <FlowInteger value={votes} /> (<FlowInteger value={percent} />%)
                    </>
                  ) : (
                    <Eye
                      className="hidden-eye-icon"
                      size={16}
                      strokeWidth={2}
                      aria-label="Hidden result"
                    />
                  )}
                </span>
              </div>
              <div className="result-bar">
                <div
                  key={`${option.id}-${votes}`}
                  className="result-fill"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          </label>
        );
      })}
    </div>
  );
}

function NumberResults(props: {
  question: PollNumberQuestionPublic | PollNumberQuestion;
  reveal: Extract<OutgoingMessage, { type: "state" }>["reveal"];
  totalResponses: number;
  showResults: boolean;
  yourNumberGuess: number | null;
}) {
  const { question, reveal, totalResponses, showResults, yourNumberGuess } = props;
  const numberReveal = reveal?.kind === "number" ? reveal : null;

  if (!showResults) {
    return <p className="muted">Results are hidden until reveal.</p>;
  }

  return (
    <div className="number-results">
      <p className="muted">
        <FlowInteger value={totalResponses} /> guess{totalResponses === 1 ? "" : "es"} submitted
      </p>
      {yourNumberGuess !== null ? (
        <p className="muted">
          Your guess: <FlowNumber value={yourNumberGuess} />
        </p>
      ) : null}
      {numberReveal ? (
        <div className="number-reveal-card">
          <p className="muted">
            Target number: <FlowNumber value={numberReveal.correctNumber} />
          </p>
          {numberReveal.winners.map((winner) => (
            <NumberWinnerResult key={winner.playMode ?? "everyone"} winner={winner} />
          ))}
          {numberReveal.isWinner ? <p className="host-lock-chip host-lock-open">You won</p> : null}
        </div>
      ) : (
        <p className="muted">Winning guess will appear after reveal.</p>
      )}
      {question.min !== undefined || question.max !== undefined ? (
        <p className="muted">
          Allowed range: {question.min ?? "-inf"} to {question.max ?? "+inf"}
        </p>
      ) : null}
    </div>
  );
}

function NumberWinnerResult(props: { winner: NumberWinner }) {
  const { winner } = props;
  if (winner.playMode === null) {
    return winner.winningGuess === null ? (
      <p className="muted">No winners this round (all guesses were over).</p>
    ) : (
      <>
        <p className="muted">
          Winning guess: <FlowNumber value={winner.winningGuess} />
        </p>
        <p className="muted">
          Winner{winner.winnerCount === 1 ? "" : "s"}: <FlowInteger value={winner.winnerCount} />
        </p>
      </>
    );
  }

  return (
    <p className="number-winner-group">
      <strong>{PLAY_MODE_LABEL[winner.playMode]}</strong>
      {winner.winningGuess === null ? (
        <span className="muted">No winner</span>
      ) : (
        <span className="muted">
          <FlowNumber value={winner.winningGuess} /> · <FlowInteger value={winner.winnerCount} /> winner
          {winner.winnerCount === 1 ? "" : "s"}
        </span>
      )}
    </p>
  );
}

function FlowNumber(props: {
  value: number;
  format?: FlowNumberProps["format"];
  trend?: number;
  className?: string;
}) {
  const { value, format, trend = 0, className } = props;
  return <NumberFlow className={className} value={value} trend={trend} format={format} />;
}

function FlowInteger(props: { value: number; className?: string; trend?: number }) {
  const { value, className, trend = 0 } = props;
  return (
    <FlowNumber
      className={className}
      value={value}
      trend={trend}
      format={{ useGrouping: false, maximumFractionDigits: 0 }}
    />
  );
}

function QuestionCounter(props: { currentQuestionIndex: number; totalQuestions: number }) {
  const { currentQuestionIndex, totalQuestions } = props;
  return (
    <>
      Question <FlowInteger value={currentQuestionIndex + 1} />/
      <FlowInteger value={totalQuestions} />
    </>
  );
}

function CountdownFlow(props: { milliseconds: number }) {
  const totalSeconds = Math.max(0, Math.ceil(props.milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return (
    <span className="countdown-flow">
      <FlowNumber
        value={hours}
        trend={-1}
        format={{ useGrouping: false, maximumFractionDigits: 0, minimumIntegerDigits: 2 }}
      />
      :
      <FlowNumber
        value={minutes}
        trend={-1}
        format={{ useGrouping: false, maximumFractionDigits: 0, minimumIntegerDigits: 2 }}
      />
      :
      <FlowNumber
        value={seconds}
        trend={-1}
        format={{ useGrouping: false, maximumFractionDigits: 0, minimumIntegerDigits: 2 }}
      />
    </span>
  );
}

function getAudienceOptionFeedback(
  isSelected: boolean,
  isCorrectOption: boolean
): "selected-correct" | "selected-wrong" | "missed-correct" | null {
  if (isSelected && isCorrectOption) return "selected-correct";
  if (isSelected && !isCorrectOption) return "selected-wrong";
  if (!isSelected && isCorrectOption) return "missed-correct";
  return null;
}

function getRoomLinks(room: string, hostKey: string, mounted: boolean) {
  const roomPath = `/r/${encodeURIComponent(room)}`;
  const hostPath = `${roomPath}/host`;
  if (!mounted || typeof window === "undefined") {
    const host = hostKey
      ? `${hostPath}?hostKey=${encodeURIComponent(hostKey)}`
      : hostPath;
    return {
      audience: roomPath,
      projector: `${roomPath}/screen`,
      host,
    };
  }

  const base = window.location.origin;
  const hostUrl = new URL(hostPath, base);
  if (hostKey) hostUrl.searchParams.set("hostKey", hostKey);

  return {
    audience: `${base}${roomPath}`,
    projector: `${base}${roomPath}/screen`,
    host: hostUrl.toString(),
  };
}

function getAudienceQrDetails(audienceUrl: string): { qrUrl: string; shortLink: string } {
  const resolvedAudienceUrl =
    typeof window === "undefined"
      ? audienceUrl
      : new URL(audienceUrl, window.location.origin).toString();
  return {
    qrUrl: `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encodeURIComponent(
      resolvedAudienceUrl
    )}`,
    shortLink:
      typeof window === "undefined"
        ? audienceUrl
        : `${window.location.host}${new URL(resolvedAudienceUrl).pathname}`,
  };
}

function getRootDomain(audienceUrl: string): string {
  if (typeof window !== "undefined") return window.location.host;
  try {
    return new URL(audienceUrl).host;
  } catch {
    return "your-domain.com";
  }
}

function parseRoomStartTimeMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function useQuestionCrossSlideTransition(stateMessage: StateMessage): {
  displayedStateMessage: StateMessage;
  outgoingStateMessage: StateMessage | null;
  isAnimating: boolean;
} {
  const [displayedStateMessage, setDisplayedStateMessage] = useState(stateMessage);
  const [outgoingStateMessage, setOutgoingStateMessage] = useState<StateMessage | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const displayedStateMessageRef = useRef(stateMessage);
  const animationTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (animationTimerRef.current !== null) {
        window.clearTimeout(animationTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const nextQuestionId = stateMessage.question?.id ?? null;
    const currentQuestionId = displayedStateMessageRef.current.question?.id ?? null;

    if (nextQuestionId === currentQuestionId) {
      displayedStateMessageRef.current = stateMessage;
      setDisplayedStateMessage(stateMessage);
      return;
    }

    const previousDisplayedState = displayedStateMessageRef.current;
    displayedStateMessageRef.current = stateMessage;
    setDisplayedStateMessage(stateMessage);

    if (animationTimerRef.current !== null) {
      window.clearTimeout(animationTimerRef.current);
      animationTimerRef.current = null;
    }

    const shouldAnimate =
      previousDisplayedState.question !== null && stateMessage.question !== null;
    if (!shouldAnimate) {
      setOutgoingStateMessage(null);
      setIsAnimating(false);
      return;
    }

    setOutgoingStateMessage(previousDisplayedState);
    setIsAnimating(true);
    animationTimerRef.current = window.setTimeout(() => {
      setIsAnimating(false);
      setOutgoingStateMessage(null);
      animationTimerRef.current = null;
    }, QUESTION_CROSS_SLIDE_MS);
  }, [stateMessage]);

  return { displayedStateMessage, outgoingStateMessage, isAnimating };
}

type SmartNextAction = "open" | "close" | "reveal" | "switch" | "none";

function getSmartNextAction(
  phase: Extract<OutgoingMessage, { type: "state" }>["phase"],
  hasNextQuestion: boolean
): SmartNextAction {
  if (phase === "idle") return "open";
  if (phase === "open") return "close";
  if (phase === "closed") return "reveal";
  return hasNextQuestion ? "switch" : "none";
}

function getSmartNextLabel(action: SmartNextAction): string {
  switch (action) {
    case "open":
      return "Open";
    case "close":
      return "Close";
    case "reveal":
      return "Reveal";
    case "switch":
      return "Question";
    case "none":
      return "Done";
  }
}

function getSmartNextDescription(action: SmartNextAction): string {
  switch (action) {
    case "open":
      return "Allow participants to submit responses in real-time.";
    case "close":
      return "Pause new submissions and prepare the reveal.";
    case "reveal":
      return "Reveal correct answers and live aggregate results.";
    case "switch":
      return "Advance to the next question and reopen voting.";
    case "none":
      return "Session complete. Reset to run again.";
  }
}

function getConfidenceLabel(totalResponses: number, participants: number): string {
  const denominator = Math.max(1, participants);
  const ratio = totalResponses / denominator;
  if (ratio >= 0.7) return "High";
  if (ratio >= 0.35) return "Medium";
  return "Low";
}

function getOrCreateVoterId(): string {
  if (typeof window === "undefined") return "";
  const existingLocal = window.localStorage.getItem(VOTER_STORAGE_KEY);
  if (existingLocal) return existingLocal;
  const existingSession = window.sessionStorage.getItem(VOTER_STORAGE_KEY);
  if (existingSession) {
    window.localStorage.setItem(VOTER_STORAGE_KEY, existingSession);
    return existingSession;
  }

  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `voter-${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem(VOTER_STORAGE_KEY, id);
  window.sessionStorage.setItem(VOTER_STORAGE_KEY, id);
  return id;
}

function saveAudienceName(value: string) {
  if (typeof window !== "undefined") window.localStorage.setItem(AUDIENCE_NAME_STORAGE_KEY, value);
}

function readAudienceName() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(AUDIENCE_NAME_STORAGE_KEY) ?? "";
}

function saveHostKey(value: string) {
  if (typeof window !== "undefined") window.localStorage.setItem(HOST_KEY_STORAGE_KEY, value);
}

function readHostKey() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(HOST_KEY_STORAGE_KEY) ?? "";
}
