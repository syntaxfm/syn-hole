import { useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import type { SyntaxLibraryRecord } from "~/syntax-game/library";
import { adminFetch, readAdminKey } from "~/utils/admin-api";
import { readErrorMessage } from "~/utils/files";
import { createSyntaxDraft, SYNTAX_ENTRIES_ENDPOINT, syntaxEntryEndpoint } from "~/utils/syntax-editor";

export function SyntaxLibrary() {
  const [key, setKey] = useState<string | null>(null);
  const [entries, setEntries] = useState<SyntaxLibraryRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState("");
  const mutations = useRef<AbortController | null>(null);
  useEffect(() => setKey(readAdminKey()), []);
  useEffect(() => {
    const controller = new AbortController(); mutations.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    setError(null);
    adminFetch(SYNTAX_ENTRIES_ENDPOINT, key, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(readErrorMessage(await response.json().catch(() => null), "Could not load library. Check your admin key."));
      const rows = await response.json() as SyntaxLibraryRecord[];
      if (!controller.signal.aborted) setEntries(rows);
    }).catch(error => { if (!controller.signal.aborted) setError(String(error.message)); });
    return () => controller.abort();
  }, [key, reload]);
  async function create() {
    setBusy(true); setError(null);
    try {
      const entry = createSyntaxDraft(crypto.randomUUID());
      const response = await adminFetch(SYNTAX_ENTRIES_ENDPOINT, key!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(entry), signal: mutations.current!.signal });
      if (!response.ok) throw new Error(readErrorMessage(await response.json().catch(() => null), "Could not create draft."));
      window.location.assign(`/admin/syntax/${entry.id}`);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not create draft."); setBusy(false); }
  }
  async function remove(entry: SyntaxLibraryRecord) {
    if (!confirm(`Delete “${entry.title || "Untitled draft"}”?`)) return;
    setBusy(true); setError(null);
    try {
      const response = await adminFetch(syntaxEntryEndpoint(entry.id), key!, { method: "DELETE", signal: mutations.current!.signal });
      if (!response.ok) throw new Error(readErrorMessage(await response.json().catch(() => null), "Could not delete entry."));
      setEntries(rows => rows!.filter(row => row.id !== entry.id));
    } catch (error) { setError(error instanceof Error ? error.message : "Could not delete entry."); }
    setBusy(false);
  }
  return <main className="app admin-app syntax-library">
    <header className="admin-header"><div><h1>Spot the Syntax Error</h1><p className="muted"><a href="/admin/">Room Admin</a> · <a href="/admin/syntax/sets/">Game sets</a> · Shared library</p></div>
      <div className="button-row"><button className="admin-action-btn" disabled={!key || busy} onClick={create}><Plus size={16} /> New code snippet image</button><button className="admin-icon-btn" aria-label="Reload library" onClick={() => setReload(value => value + 1)}><RefreshCw size={16} /></button></div></header>
    {key === "" && <p className="error"><a href="/admin/">Log in to Room Admin</a> first.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="syntax-toolbar"><label className="admin-field-label">Find screenshot<input className="text-input" type="search" placeholder="Title or language" value={search} onChange={event => setSearch(event.target.value)} /></label>{entries && <span className="syntax-status muted">{entries.length} screenshots · {entries.filter(entry => entry.status === "reviewed").length} ready</span>}</div>
    {!entries && key && !error && <p className="muted">Loading screenshots…</p>}
    {entries?.length === 0 && <section className="panel"><p>No code snippet images yet.</p><button className="admin-action-btn" disabled={!key || busy} onClick={create}><Upload size={16} /> New code snippet image</button></section>}
    {!!entries?.length && !entries.some(entry => `${entry.title} ${entry.language}`.toLowerCase().includes(search.toLowerCase())) && <p className="muted">No matching screenshots.</p>}
    <div className="syntax-library-grid">{entries?.filter(entry => `${entry.title} ${entry.language}`.toLowerCase().includes(search.toLowerCase())).map(entry => <article className="panel syntax-library-card" key={entry.id}>
      <a href={`/admin/syntax/${encodeURIComponent(entry.id)}`}>{entry.image ? <img src={entry.image.url} alt={entry.image.alt} loading="lazy" /> : <div className="syntax-thumbnail-empty"><Plus size={24} /><span>Add image</span></div>}<h2>{entry.title || "Untitled draft"}</h2></a>
      <div className="syntax-toolbar"><span className={`syntax-status is-${entry.status === "reviewed" ? "ready" : "draft"}`}>{entry.status === "reviewed" ? "Ready" : "Draft"}</span><span className="muted">{entry.language || "—"} · {entry.targets.length} {entry.targets.length === 1 ? "target" : "targets"}</span><button className="admin-icon-btn" aria-label={`Delete ${entry.title || "draft"}`} disabled={busy} onClick={() => void remove(entry)}><Trash2 size={16} /></button></div>
    </article>)}</div>
  </main>;
}
