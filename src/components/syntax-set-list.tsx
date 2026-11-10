import { useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import type { SyntaxSavedSet } from "~/syntax-game/types";
import type { SyntaxLibraryRecord } from "~/syntax-game/library";
import { adminFetch, readAdminKey } from "~/utils/admin-api";
import { readErrorMessage } from "~/utils/files";
import { SYNTAX_ENTRIES_ENDPOINT } from "~/utils/syntax-editor";
import { SYNTAX_SETS_ENDPOINT, syntaxSetEndpoint, syntaxSetLaunchIssues, syntaxSetToDraft } from "~/utils/syntax-sets";

function readinessMessage(message: string) {
  return message.replace("Screenshot is draft / unreviewed. Review it in the library before launch.", "Mark this screenshot ready in the library.")
    .replace("Screenshot is missing from the library. Remove it explicitly or restore it before launch.", "Screenshot missing. Remove this round or restore it.")
    .replace(/before review or launch/g, "before use");
}

export function SyntaxSetList() {
  const [key, setKey] = useState<string | null>(null);
  const [sets, setSets] = useState<SyntaxSavedSet[] | null>(null);
  const [entries, setEntries] = useState<SyntaxLibraryRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const lifecycle = useRef<AbortController | null>(null);
  useEffect(() => setKey(readAdminKey()), []);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController(); lifecycle.current = controller; setError(null);
    async function load() {
      const responses = await Promise.all([SYNTAX_SETS_ENDPOINT, SYNTAX_ENTRIES_ENDPOINT].map(path => adminFetch(path, key!, { signal: controller.signal })));
      for (const response of responses) if (!response.ok) throw new Error(readErrorMessage(await response.json().catch(() => null), "Could not load sets. Check your admin key."));
      const [sets, entries] = await Promise.all([responses[0].json() as Promise<SyntaxSavedSet[]>, responses[1].json() as Promise<SyntaxLibraryRecord[]>]);
      if (!controller.signal.aborted) { setSets(sets); setEntries(entries); }
    }
    void load().catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load sets."); });
    return () => controller.abort();
  }, [key, reload]);
  async function remove(set: SyntaxSavedSet) {
    if (!confirm(`Delete “${set.title}”?`)) return;
    setBusy(true); setError(null);
    const signal = lifecycle.current!.signal;
    try {
      const response = await adminFetch(syntaxSetEndpoint(set.id), key!, { method: "DELETE", signal });
      if (!response.ok) throw new Error(readErrorMessage(await response.json().catch(() => null), "Could not delete set."));
      if (!signal.aborted) setSets(rows => rows!.filter(row => row.id !== set.id));
    } catch (error) { if (!signal.aborted) setError(error instanceof Error ? error.message : "Could not delete set."); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  return <main className="app admin-app syntax-set-list">
    <header className="admin-header"><div><h1>Game sets</h1><p className="muted"><a href="/admin/">Room Admin</a> · <a href="/admin/syntax/">Spot the Syntax Error</a></p></div><div className="button-row"><a className="admin-action-btn" href="/admin/syntax/sets/new"><Plus size={16} /> New game set</a><button className="admin-icon-btn" aria-label="Reload sets" disabled={busy} onClick={() => setReload(value => value + 1)}><RefreshCw size={16} /></button></div></header>
    {key === "" && <p className="error"><a href="/admin/">Log in to Room Admin</a> first.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {!sets && key && !error && <p className="muted">Loading sets…</p>}
    {sets?.length === 0 && <section className="panel"><p>No game sets yet.</p><a className="admin-action-btn" href="/admin/syntax/sets/new"><Plus size={16} /> Create your first set</a></section>}
    <div className="syntax-library-grid">{sets?.map(set => {
      const issues = syntaxSetLaunchIssues(syntaxSetToDraft(set), entries);
      const thumbnails = set.rounds.slice(0, 4).map(round => entries.find(entry => entry.id === round.entryId));
      return <article className="panel syntax-library-card" key={set.id}><a href={`/admin/syntax/sets/${encodeURIComponent(set.id)}`}><div className="syntax-set-thumbnails">{thumbnails.map((entry, index) => entry?.image ? <img key={index} src={entry.image.url} alt={entry.image.alt} loading="lazy" /> : <span className="syntax-thumbnail-empty" key={index}>No image</span>)}{!thumbnails.length && <span className="syntax-thumbnail-empty">No rounds</span>}</div><h2>{set.title}</h2></a>
        <div className="syntax-toolbar"><span className={`syntax-status is-${issues.length ? "draft" : "ready"}`}>{issues.length ? "Draft" : "Ready"}</span><span className="muted">{set.rounds.length} rounds · {set.defaultDurationMs / 1000}s</span><button className="admin-icon-btn" aria-label={`Delete ${set.title}`} disabled={busy} onClick={() => void remove(set)}><Trash2 size={16} /></button></div>{issues.length > 0 && <details className="syntax-details"><summary>{issues.length} {issues.length === 1 ? "item" : "items"} to fix</summary><ul>{issues.map((issue, index) => <li key={index}>{readinessMessage(issue)}</li>)}</ul></details>}</article>;
    })}</div>
  </main>;
}
