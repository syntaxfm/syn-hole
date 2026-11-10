import { useEffect, useRef, useState } from "react";
import { RefreshCw, Trash2, Upload } from "lucide-react";
import { SyntaxImageSurface } from "~/components/syntax-image-surface";
import type { SyntaxLibraryRecord } from "~/syntax-game/library";
import type { SyntaxPoint } from "~/syntax-game/types";
import { syntaxIsHit } from "~/syntax-game/geometry";
import { adminFetch, readAdminKey } from "~/utils/admin-api";
import { readErrorMessage, uploadWithProgress } from "~/utils/files";
import { readImageDimensions } from "~/utils/poll-images";
import { syntaxDraftIssue, syntaxEntryEndpoint, syntaxReviewIssue, syntaxUploadIssue } from "~/utils/syntax-editor";

type SaveState = "saved" | "saving" | "failed" | "invalid";
const labels = { saved: "Saved", saving: "Saving…", failed: "Save failed", invalid: "Not saved" };

export function SyntaxEntryEditor({ entryId }: { entryId: string }) {
  const [adminKey, setAdminKey] = useState<string | null>(null);
  const [entry, setEntry] = useState<SyntaxLibraryRecord | null>(null);
  const [state, setState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const [testPoint, setTestPoint] = useState<SyntaxPoint | null>(null);
  const latest = useRef<SyntaxLibraryRecord | null>(null);
  const version = useRef(0);
  const savedVersion = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lifecycle = useRef<AbortController | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const locked = useRef(false);
  const objectUrl = useRef<string | null>(null);
  const endpoint = syntaxEntryEndpoint(entryId);

  useEffect(() => setAdminKey(readAdminKey()), []);
  useEffect(() => {
    if (!adminKey) return;
    const controller = new AbortController(); lifecycle.current = controller;
    void load(controller.signal).catch(() => {});
    return () => { controller.abort(); clearTimer(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); };
  }, [adminKey, entryId]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (locked.current || version.current !== savedVersion.current) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  function clearTimer() { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; }
  function active() { return lifecycle.current !== null && !lifecycle.current.signal.aborted; }
  async function request(path: string, options?: RequestInit) {
    const response = await adminFetch(path, adminKey!, { ...options, signal: lifecycle.current!.signal });
    if (!response.ok) throw new Error(readErrorMessage(await response.json().catch(() => null), response.status === 401 ? "Invalid admin key." : `Request failed (${response.status}).`));
    return response;
  }
  async function load(signal = lifecycle.current!.signal) {
    try {
      const response = await adminFetch(endpoint, adminKey!, { signal });
      if (!response.ok) throw new Error(readErrorMessage(await response.json().catch(() => null), "Could not load screenshot. Check your admin key."));
      const record = await response.json() as SyntaxLibraryRecord;
      if (signal.aborted) return;
      latest.current = record; setEntry(record); version.current += 1; savedVersion.current = version.current;
      setState("saved"); setError(null); setSelected(record.targets.length ? 0 : null); setTestPoint(null);
    } catch (error) { if (!signal.aborted) setError(error instanceof Error ? error.message : "Could not load screenshot."); throw error; }
  }
  /** A single queue prevents a slow older PUT from landing after a newer PUT. */
  function saveNow(): Promise<void> {
    clearTimer();
    const operation = queue.current.catch(() => {}).then(async () => {
      if (!active() || !latest.current || version.current === savedVersion.current) return;
      const record = latest.current; const atVersion = version.current;
      const issue = syntaxDraftIssue(record);
      if (issue) { setState("invalid"); setError(issue); throw new Error(issue); }
      try {
        await request(endpoint, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(record) });
        if (!active()) return;
        savedVersion.current = atVersion;
        if (version.current === atVersion) { setState("saved"); setError(null); }
      } catch (error) {
        if (active() && version.current === atVersion) { setState("failed"); setError(error instanceof Error ? error.message : "Save failed. Retry when connected."); }
        throw error;
      }
    });
    queue.current = operation; return operation;
  }
  function update(next: SyntaxLibraryRecord) {
    if (locked.current) return;
    latest.current = next; setEntry(next); version.current += 1; clearTimer(); setTestPoint(null);
    const issue = syntaxDraftIssue(next); setError(issue); setState(issue ? "invalid" : "saving");
    if (!issue) timer.current = setTimeout(() => { void saveNow().catch(() => {}); }, 500);
  }
  function edit(fields: Partial<SyntaxLibraryRecord>) {
    if (latest.current) update({ ...latest.current, ...fields, status: "draft" });
  }
  function clearPreview() { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; setPreview(null); }
  async function changeImage(file: File | null) {
    if (!latest.current || locked.current) return;
    if (file) { const issue = syntaxUploadIssue(file); if (issue) { setError(issue); return; } }
    if (latest.current.image && !confirm(`${file ? "Replace" : "Remove"} screenshot and clear its targets?`)) return;
    locked.current = true; setBusy(true); setProgress(0); setError(null); clearTimer();
    try {
      if (file) {
        const url = URL.createObjectURL(file); objectUrl.current = url; setPreview(url);
        const dimensions = await readImageDimensions(file);
        if (dimensions.width * dimensions.height > 16_000_000) throw new Error("Screenshot must be at most 16 megapixels.");
      }
      // Flush metadata before the upload; no edits or autosaves may race attachment.
      if (latest.current!.status === "reviewed") {
        latest.current = { ...latest.current!, status: "draft" };
        setEntry(latest.current); version.current += 1; setState("saving");
      }
      await saveNow();
      if (!active()) return;
      if (file) {
        const result = await uploadWithProgress({ method: "PUT", url: `${endpoint}/image`, body: file, headers: { "x-admin-key": adminKey!, "content-type": file.type }, signal: lifecycle.current!.signal, onProgress: value => { if (active()) setProgress(value); } });
        if (result.status < 200 || result.status >= 300) throw new Error(readErrorMessage(result.body, "Upload failed. Choose the file again to retry."));
      } else await request(`${endpoint}/image`, { method: "DELETE" });
      await load();
    } catch (error) { if (active()) setError(error instanceof Error ? error.message : "Image change failed."); }
    finally { if (active()) { clearPreview(); locked.current = false; setBusy(false); } }
  }
  async function reload() {
    if (locked.current || (version.current !== savedVersion.current && !confirm("Discard unsaved edits and reload the current server version?"))) return;
    locked.current = true; setBusy(true); clearTimer();
    try { await queue.current.catch(() => {}); await load(); } catch {} finally { if (active()) { locked.current = false; setBusy(false); } }
  }
  const issue = entry ? !entry.image ? "Add a screenshot." : !entry.title.trim() ? "Add a title." : !entry.language.trim() ? "Add a language." : !entry.targets.length ? "Place a target." : syntaxReviewIssue(entry) : null;
  return <main className="app admin-app question-editor syntax-editor" onClickCapture={event => {
    if ((event.target as Element).closest("a[href]") && (locked.current || version.current !== savedVersion.current) && !confirm("Leave with unsaved changes?")) event.preventDefault();
  }}>
    <header className="admin-header syntax-editor-heading"><div><h1>Screenshot editor</h1><nav className="muted"><a href="/admin/">Room Admin</a> · <a href="/admin/syntax/">Spot the Syntax Error</a></nav></div>
      <div className="button-row"><span className={`question-editor-status is-${state}`} role="status">{labels[state]}</span>{state === "failed" && <button className="admin-action-btn" disabled={!entry || busy} onClick={() => void saveNow().catch(() => {})}>Retry save</button>}<button className="admin-icon-btn" aria-label="Reload screenshot" disabled={busy || !adminKey} onClick={() => void reload()}><RefreshCw size={16} /></button></div></header>
    {adminKey === "" && <p className="error"><a href="/admin/">Log in to Room Admin</a> first.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {!entry && adminKey && !error && <p className="muted">Loading screenshot…</p>}
    {entry && <>
      <section className="syntax-editor-heading"><fieldset disabled={busy} className="syntax-editor-fields">
        <label className="admin-field-label">Title<input className="text-input" maxLength={2000} value={entry.title} onChange={event => edit({ title: event.target.value })} /></label>
        <label className="admin-field-label">Language<input className="text-input" maxLength={2000} placeholder="JavaScript, TypeScript, CSS…" value={entry.language} onChange={event => edit({ language: event.target.value })} /></label>
      </fieldset><div className="syntax-toolbar"><button className="admin-action-btn" role="switch" aria-checked={entry.status === "reviewed"} disabled={busy || (entry.status !== "reviewed" && !!issue)} onClick={() => update({ ...entry, status: entry.status === "reviewed" ? "draft" : "reviewed" })}>{entry.status === "reviewed" ? "Ready for games" : "Use in games"}</button>{entry.status !== "reviewed" && issue && <span className="muted syntax-status">{issue}</span>}</div></section>
      <div className="syntax-editor-workspace"><section className="syntax-editor-stage">
      {busy && <p className="syntax-status" role="status">{preview ? `Uploading… ${progress}%` : "Updating…"}</p>}
      {preview ? <img className="syntax-upload-preview" src={preview} alt="Uploading screenshot" /> : entry.image ? <><div className="syntax-toolbar"><h2>Targets <span className="muted">{entry.targets.length}</span></h2><button className="admin-action-btn" aria-pressed={testing} disabled={busy} onClick={() => { setTesting(value => !value); setTestPoint(null); }}>{testing ? "Edit targets" : "Test"}</button>{testing && <span className="syntax-status" role="status">{testPoint ? syntaxIsHit(testPoint, entry.targets, entry.image) ? "Hit" : "Miss" : "Test mode"}</span>}</div>
        {testing ? <SyntaxImageSurface image={entry.image} mode="play" submissionMode="first-click" disabled={busy} draftPoint={testPoint} onDraftChange={setTestPoint} onSubmit={setTestPoint} /> : <SyntaxImageSurface image={entry.image} mode="edit" disabled={busy} targets={entry.targets} selectedTargetIndex={selected} onSelectedTargetChange={setSelected} onTargetsChange={targets => {
          if (targets.length < entry.targets.length && !confirm("Remove the selected target?")) return;
          edit({ targets: [...targets] });
        }} />}
      </> : <div className="syntax-dropzone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy && event.dataTransfer.files[0]) void changeImage(event.dataTransfer.files[0]); }}><Upload size={32} /><h2>Drop a screenshot</h2><label className="admin-action-btn">Choose image<input type="file" aria-label="Upload screenshot" accept="image/png,image/jpeg,image/gif,image/webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void changeImage(file); }} /></label><span className="muted">PNG, JPEG, GIF, WebP · up to 10 MiB</span></div>}
      </section></div>
      <details className="syntax-details"><summary>Details</summary><fieldset className="syntax-editor-fields" disabled={busy}>
        <label className="admin-field-label syntax-editor-wide">Explanation (optional)<textarea className="text-input" maxLength={2000} value={entry.explanation ?? ""} onChange={event => edit({ explanation: event.target.value })} /></label>
        {(["source", "author", "license"] as const).map(field => <label className="admin-field-label" key={field}>{field === "source" ? "Source / provenance" : field === "author" ? "Author" : "License"}<input className="text-input" maxLength={2000} value={entry.provenance[field]} onChange={event => edit({ provenance: { ...entry.provenance, [field]: event.target.value } })} /></label>)}
      </fieldset>{entry.image && <div className="button-row"><label className="admin-action-btn"><Upload size={16} /> Replace screenshot<input type="file" aria-label="Replace screenshot" accept="image/png,image/jpeg,image/gif,image/webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void changeImage(file); }} /></label><button className="admin-action-btn" disabled={busy} onClick={() => void changeImage(null)}><Trash2 size={16} /> Remove screenshot</button></div>}</details>
    </>}
  </main>;
}
