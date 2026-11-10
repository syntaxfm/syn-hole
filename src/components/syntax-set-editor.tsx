import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { SyntaxLibraryRecord } from "~/syntax-game/library";
import { adminFetch, readAdminKey } from "~/utils/admin-api";
import { readErrorMessage } from "~/utils/files";
import { moveItem } from "~/utils/questions";
import { SYNTAX_ENTRIES_ENDPOINT } from "~/utils/syntax-editor";
import { createSyntaxSetDraft, parseSyntaxSetDraft, SYNTAX_SETS_ENDPOINT, syntaxSetDraftIssue, syntaxSetEndpoint, syntaxSetLaunchIssues, syntaxSetMemberIssue, syntaxSetToDraft, type SyntaxSetDraft } from "~/utils/syntax-sets";

type SaveState = "saved" | "saving" | "invalid" | "failed";
const labels = { saved: "Saved", saving: "Saving…", invalid: "Not saved", failed: "Save failed" };
function readinessMessage(message: string) {
  return message.replace("Screenshot is draft / unreviewed. Review it in the library before launch.", "Mark this screenshot ready in the library.")
    .replace("Screenshot is missing from the library. Remove it explicitly or restore it before launch.", "Screenshot missing. Remove this round or restore it.")
    .replace(/before review or launch/g, "before use");
}

export function SyntaxSetEditor({ setId }: { setId?: string }) {
  const [adminKey, setAdminKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<SyntaxSetDraft | null>(null);
  const [entries, setEntries] = useState<SyntaxLibraryRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(setId ? "saved" : "invalid");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef<SyntaxSetDraft | null>(null);
  const version = useRef(0);
  const savedVersion = useRef(0);
  const exists = useRef(!!setId);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lifecycle = useRef<AbortController | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const locked = useRef(false);

  useEffect(() => setAdminKey(readAdminKey()), []);
  useEffect(() => {
    if (!adminKey) return;
    const controller = new AbortController(); lifecycle.current = controller;
    if (setId) void loadSet().catch(() => {});
    else { const initial = createSyntaxSetDraft(crypto.randomUUID()); latest.current = initial; setDraft(initial); }
    void loadLibrary();
    return () => { controller.abort(); clearTimer(); };
  }, [adminKey, setId]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (locked.current || version.current !== savedVersion.current) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  function active() { return lifecycle.current !== null && !lifecycle.current.signal.aborted; }
  function clearTimer() { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; }
  async function request(path: string, options?: RequestInit) {
    const response = await adminFetch(path, adminKey!, { ...options, signal: lifecycle.current!.signal });
    if (!response.ok) throw new Error(readErrorMessage(await response.json().catch(() => null), response.status === 401 ? "Invalid admin key." : `Request failed (${response.status}).`));
    return response;
  }
  async function loadSet() {
    try {
      const response = await request(syntaxSetEndpoint(latest.current?.id ?? setId!));
      const record = syntaxSetToDraft(await response.json());
      if (!active()) return;
      latest.current = record; setDraft(record); version.current += 1; savedVersion.current = version.current;
      setSaveState("saved"); setError(null); exists.current = true;
    } catch (error) { if (active()) setError(error instanceof Error ? error.message : "Could not load set."); throw error; }
  }
  /** Refreshing library validity must never replace unsaved set edits. */
  async function loadLibrary() {
    setRefreshing(true); setLibraryError(null);
    try {
      const response = await request(SYNTAX_ENTRIES_ENDPOINT);
      const rows = await response.json() as SyntaxLibraryRecord[];
      if (active()) setEntries(rows);
    } catch (error) { if (active()) setLibraryError(error instanceof Error ? error.message : "Could not load library."); }
    finally { if (active()) setRefreshing(false); }
  }
  function saveNow(): Promise<void> {
    clearTimer();
    const operation = queue.current.catch(() => {}).then(async () => {
      if (!active() || !latest.current || (exists.current && version.current === savedVersion.current)) return;
      const atVersion = version.current;
      const issue = syntaxSetDraftIssue(latest.current);
      if (issue) { setSaveState("invalid"); setError(issue); return; }
      const record = parseSyntaxSetDraft(latest.current);
      const creating = !exists.current;
      // An initial POST redirects to the durable edit URL. Lock edits during that transition.
      if (!setId) { locked.current = true; setBusy(true); }
      try {
        await request(creating ? SYNTAX_SETS_ENDPOINT : syntaxSetEndpoint(record.id), { method: creating ? "POST" : "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(record) });
        if (!active()) return;
        exists.current = true; savedVersion.current = atVersion;
        if (version.current === atVersion) { setSaveState("saved"); setError(null); }
        if (!setId) { locked.current = false; window.location.replace(`/admin/syntax/sets/${encodeURIComponent(record.id)}`); }
      } catch (error) {
        if (active() && version.current === atVersion) { setSaveState("failed"); setError(error instanceof Error ? error.message : "Save failed. Retry when connected."); }
        throw error;
      } finally { if (active()) { locked.current = false; setBusy(false); } }
    });
    queue.current = operation; return operation;
  }
  function update(next: SyntaxSetDraft) {
    if (locked.current) return;
    latest.current = next; setDraft(next); version.current += 1; clearTimer();
    const issue = syntaxSetDraftIssue(next); setError(null); setSaveState(issue ? "invalid" : "saving");
    if (!issue) timer.current = setTimeout(() => { void saveNow().catch(() => {}); }, 500);
  }
  function edit(fields: Partial<SyntaxSetDraft>) { if (latest.current) update({ ...latest.current, ...fields }); }
  async function reload() {
    if (!exists.current || locked.current || (version.current !== savedVersion.current && !confirm("Discard unsaved set edits and reload?"))) return;
    clearTimer(); locked.current = true; setBusy(true);
    try { await queue.current.catch(() => {}); await loadSet(); await loadLibrary(); }
    catch {} finally { if (active()) { locked.current = false; setBusy(false); } }
  }
  const issue = draft ? syntaxSetDraftIssue(draft) : null;
  const launchIssues = draft && entries ? syntaxSetLaunchIssues(draft, entries) : [];
  const members = new Map(entries?.map(entry => [entry.id, entry]));
  const picked = new Set(draft?.rounds.map(round => round.entryId));
  const available = entries?.filter(entry => entry.status === "reviewed" && !syntaxSetMemberIssue(entry) && !picked.has(entry.id) && `${entry.title} ${entry.language}`.toLowerCase().includes(search.toLowerCase()));
  return <main className="app admin-app question-editor syntax-set-editor" onClickCapture={event => {
    if ((event.target as Element).closest("a[href]") && (locked.current || version.current !== savedVersion.current) && !confirm("Leave with unsaved set changes?")) event.preventDefault();
  }}>
    <header className="admin-header syntax-editor-heading"><div><h1>{setId ? "Game set editor" : "New game set"}</h1><nav className="muted"><a href="/admin/">Room Admin</a> · <a href="/admin/syntax/">Spot the Syntax Error</a> · <a href="/admin/syntax/sets/">Game sets</a></nav></div><div className="button-row"><span className={`question-editor-status is-${saveState}`} role="status">{labels[saveState]}</span>{saveState === "failed" && <button className="admin-action-btn" disabled={busy || !draft} onClick={() => void saveNow().catch(() => {})}>Retry save</button>}<button className="admin-icon-btn" aria-label="Reload set" disabled={busy || !setId || !adminKey} onClick={() => void reload()}><RefreshCw size={16} /></button></div></header>
    {adminKey === "" && <p className="error"><a href="/admin/">Log in to Room Admin</a> first.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {!draft && adminKey && !error && <p className="muted">Loading game set…</p>}
    {draft && <>
      <section className="syntax-set-settings"><fieldset className="syntax-editor-fields" disabled={busy}>
        <label className="admin-field-label">Set name<input className="text-input" maxLength={2000} value={draft.title} onChange={event => edit({ title: event.target.value })} /></label>
        <label className="admin-field-label">Seconds / round<input className="text-input" type="number" min={1} max={300} step={0.001} value={draft.defaultSeconds} onChange={event => edit({ defaultSeconds: event.target.value })} /></label>
      </fieldset><details className="syntax-details"><summary>Game defaults</summary><label className="admin-field-label">Suggested submission style<select className="text-input" aria-label="Default submission style" disabled={busy} value={draft.submissionMode} onChange={event => edit({ submissionMode: event.target.value === "confirm" ? "confirm" : "first-click" })}><option value="first-click">First click</option><option value="confirm">Confirm answer</option></select></label></details>
      {issue && draft.rounds.length > 0 && <p className="error" role="status">{issue}</p>}</section>
      <div className="syntax-set-workspace"><section className="panel syntax-set-chosen"><div className="syntax-toolbar"><h2>Rounds <span className="muted">{draft.rounds.length}</span></h2><span className={`syntax-status is-${entries && !launchIssues.length ? "ready" : "draft"}`}>{entries && !launchIssues.length ? "Ready" : "Draft"}</span></div>
        {!draft.rounds.length && <div className="syntax-dropzone"><Plus size={28} /><p>Add screenshots to build your set.</p></div>}
        <ol className="syntax-set-rounds">{draft.rounds.map((round, index) => {
          const entry = members.get(round.entryId);
          const memberIssue = entries ? syntaxSetMemberIssue(entry) : null;
          return <li className="syntax-set-round syntax-round-item" key={round.entryId}>
            {entry?.image ? <img src={entry.image.url} alt={entry.image.alt} loading="lazy" /> : <span className="muted">{entries ? "Missing image" : "Loading library…"}</span>}
            <div className="syntax-set-round-details"><h3>{index + 1}. {entry ? <a href={`/admin/syntax/${encodeURIComponent(entry.id)}`}>{entry.title || "Untitled screenshot"}</a> : round.entryId}</h3><span className="muted">{entry?.language || "—"}</span>{memberIssue && <p className="error">{readinessMessage(memberIssue)}</p>}</div>
            <div className="syntax-round-controls"><label className="admin-field-label">Seconds<input className="text-input" aria-label={`Round ${index + 1} seconds (optional)`} type="number" min={1} max={300} step={0.001} placeholder={draft.defaultSeconds} value={round.seconds} disabled={busy} onChange={event => edit({ rounds: draft.rounds.map((value, position) => position === index ? { ...value, seconds: event.target.value } : value) })} /></label><div className="button-row"><button className="admin-icon-btn" aria-label={`Move round ${index + 1} up`} disabled={busy || index === 0} onClick={() => edit({ rounds: moveItem(draft.rounds, index, index - 1) })}><ArrowUp size={16} /></button><button className="admin-icon-btn" aria-label={`Move round ${index + 1} down`} disabled={busy || index === draft.rounds.length - 1} onClick={() => edit({ rounds: moveItem(draft.rounds, index, index + 1) })}><ArrowDown size={16} /></button><button className="admin-icon-btn" aria-label={`Remove round ${index + 1}`} disabled={busy} onClick={() => { if (confirm(`Remove round ${index + 1}? The screenshot stays in the library.`)) edit({ rounds: draft.rounds.filter((_, position) => position !== index) }); }}><Trash2 size={16} /></button></div></div>
          </li>;
        })}</ol>
      </section>
      <aside className="panel syntax-set-library"><div className="syntax-toolbar"><h2>Screenshots</h2><button className="admin-icon-btn" aria-label="Refresh library" disabled={refreshing || busy} onClick={() => void loadLibrary()}><RefreshCw size={16} /></button></div>
        {libraryError && <p className="error" role="alert">{libraryError}</p>}
        <label className="admin-field-label">Find screenshot<input className="text-input" type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
        {!entries && !libraryError && <p className="muted">Loading library…</p>}
        {available?.length === 0 && <p className="muted">{search ? "No matches." : "No ready screenshots left."} <a href="/admin/syntax/">Open library</a></p>}
        {draft.rounds.length >= 100 && <p className="syntax-status">100-round limit reached.</p>}
        <div className="syntax-set-picker">{available?.map(entry => <button className="syntax-set-picker-item" key={entry.id} aria-label={`Add ${entry.title}`} disabled={busy || draft.rounds.length >= 100} onClick={() => { if (!latest.current!.rounds.some(round => round.entryId === entry.id)) edit({ rounds: [...latest.current!.rounds, { entryId: entry.id, seconds: "" }] }); }}><img src={entry.image!.url} alt={entry.image!.alt} loading="lazy" /><span><strong>{entry.title}</strong><span className="muted">{entry.language}</span></span><Plus size={16} aria-hidden="true" /></button>)}</div>
      </aside></div>
      {!entries ? <p className="syntax-status muted">Refresh the library to check readiness.</p> : launchIssues.length > 0 && draft.rounds.length > 0 ? <details className="syntax-details"><summary>{launchIssues.length} {launchIssues.length === 1 ? "item" : "items"} to fix</summary><ul>{launchIssues.map((message, index) => <li key={index}>{readinessMessage(message)}</li>)}</ul></details> : null}
    </>}
  </main>;
}
