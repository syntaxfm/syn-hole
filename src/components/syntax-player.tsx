import { useEffect, useRef, useState } from "react";
import { Clock3, Crosshair, LockKeyhole } from "lucide-react";
import type { SyntaxCommand, SyntaxOutgoingMessage, SyntaxStateMessage } from "~/syntax-game/protocol";
import type { SyntaxPoint, SyntaxSessionPublic } from "~/syntax-game/types";
import { SyntaxImageSurface } from "./syntax-image-surface";
import { SyntaxStandings } from "./syntax-standings";
import { SYNTAX_EMPTY_ANSWER, SyntaxClickAccumulator, syntaxAttemptAnswer, syntaxEstimatedNow, syntaxMatchesRound, syntaxReceiveAnswer, syntaxRemainingMs, type SyntaxAnswerLocal } from "./syntax-player-state";

export type SyntaxPlayerProps = {
  state: SyntaxStateMessage;
  lastMessage: SyntaxOutgoingMessage | null;
  connected: boolean;
  view: "audience" | "projector";
  send: (command: SyntaxCommand) => void;
};

/** No transport or identity ownership. The parent retains the existing room
 * join flow and delivers EVERY syntax message, including acks and click pages. */
export function SyntaxPlayer(props: SyntaxPlayerProps) {
  const { session, roundId } = props.state;
  if (!session || !roundId || props.state.mode !== "syntax") return null;
  return <SyntaxPlayerRound key={`${session.id}/${roundId}/${props.view}`} {...props} session={session} roundId={roundId} />;
}

function SyntaxPlayerRound({ state, lastMessage, connected, view, send, session, roundId }: SyntaxPlayerProps & { session: SyntaxSessionPublic; roundId: string }) {
  const gameId = session.id;
  const projector = view === "projector";
  const [answer, setAnswer] = useState<SyntaxAnswerLocal>(SYNTAX_EMPTY_ANSWER);
  const answerRef = useRef(answer);
  const updateAnswer = (next: SyntaxAnswerLocal) => { answerRef.current = next; setAnswer(next); };
  const sendRef = useRef(send);
  sendRef.current = send;
  const anchor = useRef({ serverNow: state.serverNow, wallNow: Date.now(), monotonicNow: performance.now() });
  const lastClockSample = useRef(state.serverNow);
  if (lastClockSample.current !== state.serverNow) {
    const wallNow = Date.now(), monotonicNow = performance.now();
    // A lagged broadcast must not pause/restart our progressing estimate.
    anchor.current = { serverNow: Math.max(state.serverNow, syntaxEstimatedNow(anchor.current, wallNow, monotonicNow)), wallNow, monotonicNow };
    lastClockSample.current = state.serverNow;
  }
  const highWaterNow = useRef(state.serverNow);
  const serverNow = () => {
    highWaterNow.current = Math.max(highWaterNow.current, syntaxEstimatedNow(anchor.current, Date.now(), performance.now()));
    return highWaterNow.current;
  };
  const [, tick] = useState(0);
  const remainingMs = syntaxRemainingMs(session, serverNow());
  const expired = useRef(false);
  if (session.phase === "open" && remainingMs === 0) expired.current = true;
  useEffect(() => {
    if (session.phase !== "open") return;
    const timer = window.setInterval(() => tick((value) => value + 1), 100);
    return () => window.clearInterval(timer);
  }, [session.phase]);

  const [loadAttempt, setLoadAttempt] = useState(0);
  const [imageStatus, setImageStatus] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    let cancelled = false;
    setImageStatus("loading");
    // Intentionally not mounted in the DOM while prepared. This is visual
    // preparation, not asset secrecy; no answer targets exist in these props.
    const image = new Image();
    image.onload = () => { if (!cancelled) setImageStatus("ready"); };
    image.onerror = () => { if (!cancelled) setImageStatus("failed"); };
    image.src = session.currentRound.image.url;
    return () => { cancelled = true; image.onload = null; image.onerror = null; };
  }, [session.currentRound.image.url, loadAttempt]);
  const reportedReady = useRef<string | null>(null);
  useEffect(() => {
    if (!connected) { reportedReady.current = null; return; }
    if (imageStatus === "loading" || session.phase === "finished" || session.phase === "aborted") return;
    const signature = `${loadAttempt}/${imageStatus}`;
    if (reportedReady.current === signature) return;
    reportedReady.current = signature;
    sendRef.current({ type: "syntax:ready", gameId, roundId, status: imageStatus });
  }, [connected, imageStatus, loadAttempt, gameId, roundId, session.phase]);

  useEffect(() => {
    let next = syntaxReceiveAnswer(answerRef.current, lastMessage, gameId, roundId);
    if (state.yourReceipt && syntaxMatchesRound(state.yourReceipt, gameId, roundId)) {
      next = syntaxReceiveAnswer(next, { type: "syntax:answer-ack", status: "replayed", receipt: state.yourReceipt }, gameId, roundId);
    }
    if (!connected && next.status === "pending") next = { ...next, status: "uncertain" };
    if (next !== answerRef.current) updateAnswer(next);
  }, [lastMessage, state.yourReceipt, connected, gameId, roundId]);

  const restoredReceipt = state.yourReceipt && syntaxMatchesRound(state.yourReceipt, gameId, roundId) ? state.yourReceipt : null;
  const receipt = restoredReceipt ?? answer.receipt;
  const acceptedPoint = receipt?.point ?? session.yourSubmission;
  const locked = !!acceptedPoint || !!answer.attempted;
  const canSelect = !projector && connected && imageStatus === "ready" && session.phase === "open" && remainingMs > 0 && !expired.current && !locked;
  const submit = (point: SyntaxPoint) => {
    // Recheck real time here: a background tab can delay the interval/render.
    if (!canSelect || expired.current || syntaxRemainingMs(session, serverNow()) === 0 || answerRef.current.attempted) return;
    updateAnswer(syntaxAttemptAnswer(answerRef.current, point));
    sendRef.current({ type: "syntax:answer", gameId, roundId, point });
  };
  const retryAnswer = () => {
    const point = answerRef.current.attempted;
    if (!connected || !point || acceptedPoint || projector) return;
    updateAnswer({ ...answerRef.current, status: "pending", error: null });
    sendRef.current({ type: "syntax:answer", gameId, roundId, point });
  };

  const [clicks, setClicks] = useState<readonly SyntaxPoint[]>([]);
  const accumulator = useRef<SyntaxClickAccumulator | null>(null);
  const [pageVersion, setPageVersion] = useState(0);
  const [clickError, setClickError] = useState<string | null>(null);
  const reveal = session.reveal?.roundIndex === session.currentRound.roundIndex ? session.reveal : null;
  useEffect(() => {
    if (!projector || !reveal || !session.clicks || session.clicks.roundIndex !== session.currentRound.roundIndex || accumulator.current) return;
    accumulator.current = new SyntaxClickAccumulator(session.clicks);
    setClicks(accumulator.current.points);
    setPageVersion((value) => value + 1);
  }, [projector, reveal, session.clicks, session.currentRound.roundIndex]);
  useEffect(() => {
    if (!projector || !reveal || !lastMessage) return;
    if (lastMessage.type === "syntax:clicks" && syntaxMatchesRound(lastMessage, gameId, roundId) && accumulator.current?.accept(lastMessage.page)) {
      setClicks(accumulator.current.points);
      setClickError(null);
      setPageVersion((value) => value + 1);
    }
    if (lastMessage.type === "syntax:error" && lastMessage.command === "syntax:clicks" && syntaxMatchesRound(lastMessage, gameId, roundId)) setClickError(lastMessage.message);
  }, [lastMessage, projector, reveal, gameId, roundId]);
  useEffect(() => {
    if (!projector || !reveal || !connected) return;
    const offset = accumulator.current?.request();
    if (offset !== null && offset !== undefined) sendRef.current({ type: "syntax:clicks", gameId, roundId, offset });
  }, [pageVersion, projector, !!reveal, connected, gameId, roundId]);

  const terminal = session.phase === "finished" || session.phase === "aborted";
  const showImage = session.phase !== "prepared" && !terminal;
  const waitingReveal = session.phase === "closed" || (session.phase === "open" && (remainingMs === 0 || expired.current));
  const awaitingReveal = waitingReveal && !reveal && !terminal;
  const answerLocked = !projector && !!acceptedPoint && !reveal && !terminal;
  const roundFeedback = awaitingReveal ? "closed" : answerLocked ? "locked" : null;
  const statusError = !connected ? "Disconnected" : !terminal && imageStatus === "failed" ? "Image unavailable" : !projector && !acceptedPoint && answer.error ? answer.error : null;
  const status = statusError ?? (terminal ? session.phase === "finished" ? "Game complete" : "Game ended" : session.phase === "prepared" ? "Get ready" : reveal ? "Answers revealed" : waitingReveal ? "Time’s up" : !projector && acceptedPoint ? "Answer locked" : !projector && answer.attempted ? answer.status === "uncertain" ? "Answer not confirmed" : answer.status === "rejected" ? "Answer not accepted" : "Sending…" : imageStatus === "loading" ? "Loading image…" : projector ? "Find the error" : session.submissionMode === "confirm" || answer.draft ? "Choose a spot, then confirm" : "Tap the error");
  const standings = <SyntaxStandings standings={session.standings} roundStandings={reveal ? session.roundStandings : []} yourStanding={projector ? null : session.yourStanding} yourRoundStanding={projector ? null : session.yourRoundStanding} final={terminal} />;
  return <section className={`syntax-game ${projector ? "is-projector" : "is-audience"}`} aria-label="Spot the Syntax Error">
    <header className="syntax-round-bar">
      <div className="syntax-round-meta">
        <span className="muted">{session.title}</span>
        <h2>{terminal ? session.phase === "finished" ? "Game complete" : "Game ended" : session.currentRound.title}</h2>
        <span>Round {session.currentRound.roundIndex + 1} / {session.totalRounds} · {session.totalResponses} / {session.participants} answered</span>
      </div>
      {awaitingReveal ? <div className="syntax-round-ended"><Clock3 size={28} aria-hidden="true" /><strong>Time’s up</strong></div>
        : !terminal && !reveal && <div className="syntax-countdown" data-urgent={session.phase === "open" && remainingMs <= 5000} role="timer" aria-label="Seconds remaining">{session.phase === "prepared" ? Math.ceil(session.currentRound.durationMs / 1000) : expired.current ? 0 : Math.ceil(remainingMs / 1000)}<span aria-hidden="true">s</span></div>}
    </header>
    {roundFeedback && <div className={`syntax-round-feedback is-${roundFeedback}`} data-round-feedback={roundFeedback} role="status" aria-live="polite" aria-atomic="true">
      {awaitingReveal ? <Clock3 size={26} aria-hidden="true" /> : <LockKeyhole size={26} aria-hidden="true" />}
      <div><strong>{awaitingReveal ? "Answers closed" : "Answer locked"}</strong><span>Waiting for {awaitingReveal ? "the host to reveal" : "answer reveal"}</span></div>
      {awaitingReveal && answerLocked && <span className="syntax-locked-receipt"><LockKeyhole size={14} aria-hidden="true" /> Your answer is locked</span>}
    </div>}
    <div className={`syntax-game-workspace${!reveal && !terminal ? " is-playing" : ""}`}>
      <div className={`syntax-game-stage${awaitingReveal ? " is-awaiting-reveal" : answerLocked ? " is-answer-locked" : ""}`}>
        {terminal ? standings : showImage && imageStatus === "ready" ? (projector || reveal
      ? <SyntaxImageSurface key={`${roundId}/${loadAttempt}`} mode="reveal" image={session.currentRound.image} targets={reveal?.targets ?? []} revealedPoints={projector && reveal ? clicks : undefined} submittedPoint={projector ? null : acceptedPoint} label={projector ? "Read-only round screenshot" : "Your revealed round"} />
      : <SyntaxImageSurface key={`${roundId}/${loadAttempt}`} mode="play" image={session.currentRound.image} submissionMode={session.submissionMode} disabled={!canSelect} draftPoint={acceptedPoint ? null : answer.draft} submittedPoint={acceptedPoint ?? answer.attempted} onDraftChange={(point) => { if (canSelect && !answerRef.current.attempted) updateAnswer({ ...answerRef.current, draft: point }); }} onSubmit={submit} />)
          : <div className="syntax-phase-state"><Crosshair size={44} strokeWidth={1.5} aria-hidden="true" /><strong>{session.phase === "prepared" ? "Get ready" : imageStatus === "failed" ? "Image unavailable" : "Loading…"}</strong></div>}
      </div>
      {!terminal && <aside className="syntax-game-rail" aria-label="Round status">
        {(!roundFeedback || statusError) && <div className={`syntax-status${statusError ? " error" : ""}`} role={statusError ? "alert" : "status"}>{status}</div>}
        {imageStatus === "failed" && <button type="button" className="admin-action-btn" onClick={() => setLoadAttempt((value) => value + 1)}>Retry image</button>}
        {!projector && !acceptedPoint && answer.attempted && answer.status !== "pending" && <button type="button" className="admin-action-btn" disabled={!connected} onClick={retryAnswer}>Retry answer</button>}
        {reveal && <>
          <section className="syntax-result" aria-label="Round result">
            {!projector && reveal.yourResult && <strong>{!acceptedPoint ? "No answer" : reveal.yourResult.correct ? "Correct" : "Miss"} · {reveal.yourResult.points} points</strong>}
            {reveal.explanation && <div>{reveal.explanation}</div>}
            {projector && session.clicks && <><span className="muted">{clicks.length} / {session.clicks.total} clicks</span>{clickError && <div className="error" role="alert">{clickError}</div>}{clicks.length < session.clicks.total && <button type="button" className="admin-action-btn" disabled={!connected} onClick={() => { accumulator.current?.retry(); setClickError(null); setPageVersion((value) => value + 1); }}>Retry remaining clicks</button>}</>}
          </section>
          {standings}
        </>}
        {!reveal && session.revealedRounds > 0 && <details className="syntax-previous-standings"><summary>Previous standings</summary>{standings}</details>}
      </aside>}
    </div>
  </section>;
}
