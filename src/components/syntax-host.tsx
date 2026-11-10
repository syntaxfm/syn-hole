import { useEffect, useRef, useState } from "react";
import { Crosshair } from "lucide-react";
import type { SyntaxCommand, SyntaxStateMessage } from "~/syntax-game/protocol";
import type { SyntaxSubmissionMode } from "~/syntax-game/types";
import { parseSyntaxHostSets, syntaxHostControls, syntaxHostNow, type SyntaxHostSet } from "~/utils/syntax-host";
import { SyntaxImageSurface } from "./syntax-image-surface";

export type SyntaxHostProps = {
  room: string;
  hostKey: string;
  state: SyntaxStateMessage | null;
  connected: boolean;
  /** Reuse the room's negotiated socket (syntaxProtocol=1). No new transport. */
  send: (command: SyntaxCommand) => void;
  pending?: boolean;
  /** Parent should clear the previous syntax error when sending a new command. */
  error?: string | null;
};

export function SyntaxHost({ room, hostKey, state, connected, send, pending = false, error }: SyntaxHostProps) {
  const [sets, setSets] = useState<SyntaxHostSet[]>([]);
  const [setId, setSetId] = useState("");
  const [submissionOverride, setSubmissionOverride] = useState<SyntaxSubmissionMode | null>(null);
  const [loadError, setLoadError] = useState("");
  const [localError, setLocalError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const inFlight = useRef(false);
  const [clock, setClock] = useState(0);
  const sample = useRef<{ state: SyntaxStateMessage; at: number } | null>(null);
  const session = state?.session ?? null;
  const [imageStatus, setImageStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [imageRetry, setImageRetry] = useState(0);
  const [returnAfterAbort, setReturnAfterAbort] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setSets([]); setLoadError("");
    if (!hostKey) { setLoading(false); return; }
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/syntax/sets`, { headers: { "x-host-key": hostKey }, signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(response.status === 401 ? "Host key rejected. Check the room's host key, then reload sets." : `Could not load saved sets (${response.status}). Retry loading sets.`);
        const next = parseSyntaxHostSets(await response.json());
        if (controller.signal.aborted) return;
        setSets(next); setSetId((current) => next.some((set) => set.id === current) ? current : next[0]?.id ?? "");
      } catch (cause) { if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : "Could not load sets. Retry loading sets."); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [room, hostKey, reload]);

  useEffect(() => {
    if (state) sample.current = { state, at: performance.now() };
    setClock((tick) => tick + 1);
  }, [state]);
  // Readiness/answer broadcasts are not command acknowledgements. Unlock only
  // when the authoritative lifecycle changes (or on an explicit error/timeout).
  useEffect(() => {
    inFlight.current = false; setWaiting(false);
  }, [state?.mode, session?.id, session?.phase, state?.roundId]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock((tick) => tick + 1), 100);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { if (error) { inFlight.current = false; setWaiting(false); setReturnAfterAbort(null); } }, [error]);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => {
      inFlight.current = false; setWaiting(false);
      setLocalError("Action not confirmed. Check connection and retry.");
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  const image = session?.currentRound.image;
  useEffect(() => {
    setImageStatus("loading");
    if (!image) return;
    let disposed = false;
    const preload = new Image();
    preload.onload = () => { if (!disposed) setImageStatus("ready"); };
    preload.onerror = () => { if (!disposed) setImageStatus("failed"); };
    preload.src = image.url;
    return () => { disposed = true; preload.onload = null; preload.onerror = null; };
  }, [image?.url, state?.roundId, imageRetry]);

  // `clock` drives a render, not a decrementing timer that could restart on reconnect.
  void clock;
  const now = sample.current ? syntaxHostNow(sample.current.state.serverNow, sample.current.at, performance.now()) : state?.serverNow ?? 0;
  const controls = syntaxHostControls(session, now);
  const busy = pending || waiting || !connected || !state || !hostKey;
  const issue = (command: SyntaxCommand) => {
    if (busy || inFlight.current) return;
    inFlight.current = true; setWaiting(true); setLocalError("");
    try { send(command); }
    catch (cause) { inFlight.current = false; setWaiting(false); setLocalError(cause instanceof Error ? cause.message : "Could not send. Reconnect and retry."); }
  };
  useEffect(() => {
    if (returnAfterAbort && session?.id === returnAfterAbort && session.phase === "aborted" && state?.mode === "syntax" && !busy) {
      setReturnAfterAbort(null); issue({ type: "syntax:polls" });
    }
  }, [returnAfterAbort, session?.id, session?.phase, state?.mode, busy]);
  const transition = (type: "syntax:open" | "syntax:reveal" | "syntax:next" | "syntax:finish" | "syntax:abort") => {
    if (session && state?.roundId) issue({ type, gameId: session.id, roundId: state.roundId });
  };
  const selected = sets.find((set) => set.id === setId);
  const submissionMode = submissionOverride ?? selected?.submissionMode ?? "first-click";
  const active = state?.mode === "syntax" && session;

  return <section className="syntax-game syntax-host" data-active={!!active} aria-label="Syntax game host">
    <header className="syntax-round-bar">
      <div className="syntax-round-meta">
        <span className="host-lock-chip">{active ? session.phase : "Poll mode"}</span>
        <h2>{active ? session.title : "Spot the Syntax Error"}</h2>
        {active && <span>Round {session.currentRound.roundIndex + 1} / {session.totalRounds} · {session.currentRound.title}</span>}
      </div>
    </header>
    <div className="syntax-game-workspace">
      <section className="syntax-game-stage syntax-host-preview" aria-label="Host preview">
        {active && image ? <>
          {imageStatus === "failed" ? <div className="syntax-phase-state"><strong>Image unavailable</strong><button className="host-secondary-btn" onClick={() => setImageRetry((value) => value + 1)}>Retry image</button></div>
            : <SyntaxImageSurface key={`${state.roundId}:${imageRetry}`} mode="reveal" image={image} targets={session.reveal?.targets ?? []} label="Host screenshot preview" />}
          {session.reveal?.explanation && <div className="syntax-result">{session.reveal.explanation}</div>}
        </> : <div className="syntax-phase-state"><Crosshair size={44} strokeWidth={1.5} aria-hidden="true" /><strong>Prepare a game</strong></div>}
      </section>
      <aside className="syntax-game-rail panel host-card" aria-label="Game controls">
        <div className={`syntax-status${error || localError || !connected || !hostKey ? " error" : ""}`} role={error || localError ? "alert" : "status"}>{error || localError || (!hostKey ? "Host key required" : !connected ? "Disconnected" : !state ? "Connecting…" : waiting ? "Sending…" : active ? session.phase === "open" && controls.remainingMs === 0 ? "Time’s up" : session.phase === "prepared" ? "Ready to start" : session.phase === "closed" ? "Ready to reveal" : session.phase === "revealed" ? "Answers revealed" : session.phase === "finished" ? "Game complete" : session.phase === "aborted" ? "Game ended" : "Round live" : "Choose a game set")}</div>
        {!active && <>
          <label className="host-input-label">Game set<select className="text-input" value={setId} disabled={loading || busy} onChange={(event) => { setSetId(event.target.value); setSubmissionOverride(null); }}><option value="">Choose a set</option>{sets.map((set) => <option key={set.id} value={set.id}>{set.title}</option>)}</select></label>
          {loadError && <div className="error" role="alert">{loadError}</div>}
          {!loading && !loadError && hostKey && !sets.length && <div className="muted">No saved sets</div>}
          {(loadError || !sets.length) && <button className="host-secondary-btn" disabled={loading || !hostKey} onClick={() => setReload((value) => value + 1)}>{loading ? "Loading…" : "Reload sets"}</button>}
          <label className="host-input-label">Submission<select className="text-input" value={submissionMode} disabled={busy} onChange={(event) => setSubmissionOverride(event.target.value as SyntaxSubmissionMode)}><option value="first-click">First tap locks</option><option value="confirm">Select, then confirm</option></select></label>
          {selected && <span className="muted">{selected.roundCount} rounds · {selected.defaultDurationMs / 1000}s</span>}
          <button className="host-launch-btn" disabled={busy || !selected || !controls.launch} onClick={() => issue({ type: "syntax:launch", setId, submissionMode })}>Prepare game</button>
        </>}
        {active && <>
          {(session.phase === "prepared" || session.phase === "open" || session.phase === "closed") && <div className="syntax-countdown" data-urgent={session.phase === "open" && controls.remainingMs <= 5000} role="timer" aria-label="Seconds remaining">{session.phase === "prepared" ? Math.ceil(session.currentRound.durationMs / 1000) : Math.ceil(controls.remainingMs / 1000)}<span aria-hidden="true">s</span></div>}
          <div className="syntax-round-meta"><strong>{session.totalResponses} / {session.participants} answered</strong>{state.host && <span className="muted">{state.host.ready} ready · {state.host.connected} connected</span>}</div>
          <div className="syntax-phase-actions">
            {controls.start && <button className="host-launch-btn" disabled={busy} onClick={() => transition("syntax:open")}>Start round</button>}
            {(session.phase === "open" || session.phase === "closed") && <button className="host-launch-btn" disabled={busy || !controls.reveal} onClick={() => transition("syntax:reveal")}>Reveal answers</button>}
            {controls.next && <button className="host-launch-btn" disabled={busy} onClick={() => transition("syntax:next")}>Next round</button>}
            {controls.finish && <button className="host-launch-btn" disabled={busy} onClick={() => transition("syntax:finish")}>Finish game</button>}
            {controls.polls && <button className="host-launch-btn" disabled={busy} onClick={() => issue({ type: "syntax:polls" })}>Return to polls</button>}
          </div>
          <details className="syntax-host-overflow"><summary>More</summary>
            {controls.abort && <button className="host-secondary-btn" disabled={busy} onClick={() => { if (window.confirm("End this game and return to polls?")) { setReturnAfterAbort(session.id); transition("syntax:abort"); } }}>End game</button>}
            <dl><dt>Image</dt><dd>{imageStatus}</dd><dt>Failed clients</dt><dd>{state.host?.failed ?? "—"}</dd><dt>Submission</dt><dd>{session.submissionMode === "first-click" ? "First tap locks" : "Select, then confirm"}</dd><dt>Groups</dt><dd>{session.askPlayMode ? "In person / online" : "Everyone"}</dd></dl>
          </details>
        </>}
      </aside>
    </div>
  </section>;
}
