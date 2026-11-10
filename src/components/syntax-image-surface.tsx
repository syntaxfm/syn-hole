import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { Move, Plus, RotateCcw, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { syntaxClientPoint, syntaxIsHit } from "~/syntax-game/geometry";
import type { SyntaxImage, SyntaxPoint, SyntaxSubmissionMode, SyntaxTarget } from "~/syntax-game/types";
import { SYNTAX_MAX_RADIUS } from "~/syntax-game/validation";
import { SYNTAX_INITIAL_VIEW, SYNTAX_MAX_ZOOM, SyntaxSurfaceGesture, syntaxKeyboardPoint, syntaxSurfaceTransform, syntaxZoomView, type SyntaxView } from "./syntax-image-interaction";

type CommonProps = {
  image: SyntaxImage;
  className?: string;
  label?: string;
  /** Stops selection/editing, but keeps inspection/zoom available. */
  disabled?: boolean;
  draftPoint?: SyntaxPoint | null;
  submittedPoint?: SyntaxPoint | null;
};
export type SyntaxImageSurfaceProps = CommonProps & (
  | { mode: "play"; submissionMode: SyntaxSubmissionMode; onDraftChange: (point: SyntaxPoint | null) => void; onSubmit: (point: SyntaxPoint) => void; targets?: never; revealedPoints?: never }
  | { mode: "edit"; targets: readonly SyntaxTarget[]; selectedTargetIndex: number | null; onSelectedTargetChange: (index: number | null) => void; onTargetsChange: (targets: readonly SyntaxTarget[]) => void; revealedPoints?: never }
  | { mode: "reveal"; targets: readonly SyntaxTarget[]; /** Anonymous coordinates only, never player records. */ revealedPoints?: readonly SyntaxPoint[] }
);

/** Controlled domain state; only viewport and the uncommitted keyboard cursor are local.
 * Key the surface by round ID when the same image is used in successive rounds.
 * A pointer tap submits only in first-click mode; keyboard always confirms explicitly.
 */
export function SyntaxImageSurface(props: SyntaxImageSurfaceProps) {
  return <SyntaxImageSurfaceContent key={props.image.url} {...props} />;
}

function SyntaxImageSurfaceContent(props: SyntaxImageSurfaceProps) {
  const { image } = props;
  const helpId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const gesture = useRef(new SyntaxSurfaceGesture());
  const [view, setView] = useState<SyntaxView>(SYNTAX_INITIAL_VIEW);
  const viewRef = useRef(view);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [cursor, setCursor] = useState<SyntaxPoint>({ x: 0.5, y: 0.5 });
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [editTool, setEditTool] = useState<"place" | "move">(props.mode === "edit" && props.targets.length ? "move" : "place");
  const valid = Number.isFinite(image.width) && image.width > 0 && Number.isFinite(image.height) && image.height > 0;
  const editable = props.mode !== "reveal" && !props.disabled && loaded && valid && !(props.mode === "play" && props.submittedPoint);
  const updateView = (next: SyntaxView) => { viewRef.current = next; setView(next); };

  useEffect(() => {
    // A phase/permission transition must not revive a contact begun earlier.
    gesture.current.clear();
  }, [props.mode, editable]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      gesture.current.clear();
      // Preserve fractional CSS pixels so overlays and DOMRect hit tests agree.
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    const invalidate = () => gesture.current.invalidate();
    window.addEventListener("scroll", invalidate, true);
    window.addEventListener("blur", invalidate);
    return () => { observer.disconnect(); window.removeEventListener("scroll", invalidate, true); window.removeEventListener("blur", invalidate); };
  }, []);

  const selected = props.mode === "edit" && props.selectedTargetIndex !== null ? props.targets[props.selectedTargetIndex] : undefined;
  const point = selected ?? props.draftPoint ?? cursor;
  const choose = (next: SyntaxPoint, pointerTap: boolean) => {
    if (!editable) return;
    setCursor(next);
    if (props.mode === "edit") {
      if (editTool === "place") {
        if (pointerTap) {
          props.onTargetsChange([...props.targets, { ...next, radius: 0.025 }]);
          props.onSelectedTargetChange(props.targets.length);
          setEditTool("move");
        }
        return;
      }
      const hit = pointerTap ? props.targets.findIndex(target => syntaxIsHit(next, [target], image)) : -1;
      if (hit !== -1) { props.onSelectedTargetChange(hit); return; }
      if (props.selectedTargetIndex === null) return;
      props.onTargetsChange(props.targets.map((target, index) => index === props.selectedTargetIndex ? { ...target, ...next } : target));
    } else if (props.mode === "play") {
      props.onDraftChange(next);
      if (pointerTap && props.submissionMode === "first-click") props.onSubmit(next);
    }
  };
  const client = (event: PointerEvent) => ({ x: event.clientX, y: event.clientY });
  const box = () => {
    const element = viewport.current!;
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };
  const transform = valid && size.width > 0 && size.height > 0
    ? syntaxSurfaceTransform(image, { left: 0, top: 0, ...size }, view) : null;
  const targets = props.mode === "play" ? [] : props.targets;
  const marker = (value: SyntaxPoint, kind: string, key: string | number) => transform && <span key={key} className={`syntax-image-marker ${kind}`} style={{ left: transform.e + value.x * transform.a, top: transform.f + value.y * transform.d }} />;
  const zoom = (factor: number) => { gesture.current.invalidate(); updateView(syntaxZoomView(viewRef.current, viewRef.current.zoom * factor)); };
  const resizeTarget = (radius: number) => {
    if (props.mode !== "edit" || !editable || !selected) return;
    props.onTargetsChange(props.targets.map((target, index) => index === props.selectedTargetIndex
      ? { ...target, radius: Math.max(0.002, Math.min(SYNTAX_MAX_RADIUS, radius)) } : target));
  };

  return <div className={`syntax-image-surface u-grid-gap-7 ${props.className ?? ""}`} style={{ "--syntax-image-ratio": `${image.width} / ${image.height}` } as CSSProperties}
    onPointerDownCapture={(event) => { if (!viewport.current?.contains(event.target as Node)) gesture.current.invalidate(); }}>
    <div className="syntax-surface-toolbar">
      {props.mode === "edit" && <div className="syntax-tool-group" role="group" aria-label="Target tools">
        <button type="button" className="admin-action-btn" aria-pressed={editTool === "place"} disabled={!editable} onClick={() => { setEditTool("place"); props.onSelectedTargetChange(null); }}><Plus size={15} /> Place target</button>
        <button type="button" className="admin-action-btn" aria-pressed={editTool === "move"} disabled={!editable || !props.targets.length} onClick={() => setEditTool("move")}><Move size={15} /> Move</button>
      </div>}
      <div className="syntax-tool-group syntax-view-tools" role="group" aria-label="Image view controls">
        <button type="button" className="admin-icon-btn" aria-label="Zoom out" title="Zoom out" disabled={view.zoom <= 1} onClick={() => zoom(1 / 1.5)}><ZoomOut size={17} /></button>
        <span className="muted">{Math.round(view.zoom * 100)}%</span>
        <button type="button" className="admin-icon-btn" aria-label="Zoom in" title="Zoom in" disabled={view.zoom >= SYNTAX_MAX_ZOOM} onClick={() => zoom(1.5)}><ZoomIn size={17} /></button>
        <button type="button" className="admin-icon-btn" aria-label="Reset view" title="Reset view" onClick={() => { gesture.current.invalidate(); updateView(SYNTAX_INITIAL_VIEW); }}><RotateCcw size={16} /></button>
      </div>
    </div>
    <div className="syntax-image-viewport" ref={viewport} role="group" tabIndex={0}
      aria-label={props.label ?? (props.mode === "edit" ? "Image target editor" : "Image answer surface")}
      aria-describedby={helpId} aria-disabled={!editable}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || !editable || event.altKey || event.ctrlKey || event.metaKey) return;
        const next = syntaxKeyboardPoint(point, event.key, image.width, image.height, event.shiftKey);
        if (next) { event.preventDefault(); setKeyboardActive(true); choose(next, false); }
        if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
          event.preventDefault(); setKeyboardActive(true); choose(point, props.mode === "edit");
          if (props.mode === "play") props.onSubmit(point);
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current.down(event.pointerId, client(event), event.timeStamp);
        if (!valid || !loaded) gesture.current.invalidate();
        else {
          const bounds = box();
          if (!syntaxClientPoint(client(event), syntaxSurfaceTransform(image, bounds, viewRef.current), bounds)) gesture.current.invalidate();
        }
        setKeyboardActive(false);
      }}
      onPointerMove={(event) => {
        if (!valid) return;
        updateView(gesture.current.move(event.pointerId, client(event), box(), viewRef.current));
      }}
      onPointerUp={(event) => {
        // Process a last displacement even if the browser coalesced pointermove.
        if (valid) updateView(gesture.current.move(event.pointerId, client(event), box(), viewRef.current));
        const tap = gesture.current.up(event.pointerId, client(event), event.timeStamp);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (!tap || !editable) return;
        const bounds = box();
        const next = syntaxClientPoint(client(event), syntaxSurfaceTransform(image, bounds, viewRef.current), bounds);
        if (next) choose(next, true);
      }}
      onPointerCancel={(event) => gesture.current.cancel(event.pointerId)}
      onLostPointerCapture={(event) => gesture.current.cancel(event.pointerId)}
      onWheel={() => gesture.current.invalidate()}>
      {transform && <img src={image.url} alt={image.alt} width={image.width} height={image.height} draggable={false}
        onLoad={() => { setLoaded(true); setFailed(false); }} onError={() => { setLoaded(false); setFailed(true); }}
        style={{ left: transform.e, top: transform.f, width: transform.a, height: transform.d }} />}
      <div className="syntax-image-overlays" aria-hidden="true">
        {transform && targets.map((target, index) => <span key={index} className={`syntax-image-target${props.mode === "edit" && index === props.selectedTargetIndex ? " is-selected" : ""}`}
          style={{ left: transform.e + target.x * transform.a, top: transform.f + target.y * transform.d, width: 2 * target.radius * transform.a, height: 2 * target.radius * transform.a }}>{index + 1}</span>)}
        {props.mode === "reveal" && props.revealedPoints?.map((value, index) => marker(value, "is-revealed", index))}
        {props.draftPoint && marker(props.draftPoint, "is-draft", "draft")}
        {props.submittedPoint && marker(props.submittedPoint, "is-submitted", "submitted")}
        {keyboardActive && editable && marker(point, "is-cursor", "cursor")}
      </div>
        {props.mode === "edit" && selected && transform && <button type="button" className="syntax-target-resize" aria-label="Resize target" title="Drag to resize" disabled={!editable}
          style={{ left: transform.e + (selected.x + selected.radius) * transform.a, top: transform.f + selected.y * transform.d }}
          onPointerDown={event => { event.stopPropagation(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const bounds = box();
            const local = syntaxClientPoint(client(event), syntaxSurfaceTransform(image, bounds, viewRef.current), bounds);
            if (local) resizeTarget(Math.hypot(local.x - selected.x, (local.y - selected.y) * image.height / image.width));
          }}
          onPointerUp={event => { event.stopPropagation(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resizeTarget(selected.radius + (event.key === "ArrowRight" ? 0.002 : -0.002)); } }} />}
    </div>
    {(!valid || failed) && <p className="error" role="alert">{failed ? "Image could not be loaded." : "Image dimensions must be positive."}</p>}
    <span id={helpId} className="syntax-sr-only">Drag to pan. Pinch to zoom. Arrow keys move the marker; Shift adjusts finely. Enter confirms.</span>
    {props.mode === "edit" && <div className="syntax-target-inspector">
      <div className="syntax-tool-group" role="group" aria-label="Accepted targets">
        {props.targets.map((_, index) => <button key={index} type="button" className="admin-action-btn syntax-target-chip" aria-label={`Select target ${index + 1}`} aria-pressed={props.selectedTargetIndex === index} disabled={!editable} onClick={() => { props.onSelectedTargetChange(index); setEditTool("move"); }}>{index + 1}</button>)}
        {!props.targets.length && <span className="muted">Click the error to place a target</span>}
      </div>
      {selected && <><label className="syntax-size-control">Target size
        <input type="range" aria-label="Target size" min={0.002} max={Math.max(0.15, selected.radius)} step={0.001} value={selected.radius} disabled={!editable} onChange={event => resizeTarget(event.currentTarget.valueAsNumber)} />
      </label><button type="button" className="admin-icon-btn" aria-label="Remove target" title="Remove target" disabled={!editable} onClick={() => { props.onTargetsChange(props.targets.filter((_, index) => index !== props.selectedTargetIndex)); props.onSelectedTargetChange(null); setEditTool("place"); }}><Trash2 size={16} /></button></>}
    </div>}
    {props.mode === "play" && (props.submissionMode === "confirm" || keyboardActive) && !props.submittedPoint && <button type="button" className="syntax-confirm" disabled={!editable || !props.draftPoint} onClick={() => { if (editable && props.draftPoint) props.onSubmit(props.draftPoint); }}>Confirm answer</button>}
  </div>;
}
