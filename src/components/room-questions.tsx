import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Plus, Trash2, X } from "lucide-react";
import { OptionImageSlot } from "~/components/option-image-slot";
import type {
  PollChoiceQuestion,
  PollNumberQuestion,
  PollQuestion,
  ReplaceQuestionsSource,
  RoomOptionImages,
  RoomQuestionsResponse,
  StoredOptionImage,
} from "~/types";
import {
  adminFetch,
  getAdminRoomSettingsEndpoint,
  getRoomQuestionsEndpoint,
  readAdminKey,
} from "~/utils/admin-api";
import { readErrorMessage } from "~/utils/files";
import { getRoomSettingsEndpoint, parseRoomSettings } from "~/utils/play-mode";
import {
  changeQuestionType,
  createOption,
  createQuestion,
  getOptionName,
  getQuestionIssue,
  getQuestionType,
  moveItem,
  parseOptionalNumber,
  parseQuestionType,
} from "~/utils/questions";

type SaveState = "saved" | "saving" | "invalid" | "failed";

const AUTOSAVE_DELAY_MS = 500;
/** Rooms not created in Admin (like the default one) still exist and can be copied. */
const DEFAULT_ROOM_NAME = "main-stage";

const SAVE_STATE_LABEL: Record<SaveState, string> = {
  saved: "Saved",
  saving: "Saving…",
  invalid: "Not saved",
  failed: "Save failed",
};

export function RoomQuestionsEditor(props: { room: string }) {
  const { room } = props;
  // Read after mount: the server can't see the stored key, and both renders must match.
  const [storedAdminKey, setStoredAdminKey] = useState<string | null>(null);
  const adminKey = storedAdminKey ?? "";
  const [questions, setQuestions] = useState<PollQuestion[] | null>(null);
  const [images, setImages] = useState<RoomOptionImages>({});
  const [otherRooms, setOtherRooms] = useState<string[]>([]);
  const [askPlayMode, setAskPlayMode] = useState<boolean | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const latestQuestions = useRef<PollQuestion[]>([]);
  const changeVersion = useRef(0);
  const saveTimer = useRef<number | null>(null);

  async function loadQuestions() {
    const response = await adminFetch(getRoomQuestionsEndpoint(room), adminKey);
    if (response.status === 401) throw new Error("unauthorized");
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = (await response.json()) as RoomQuestionsResponse;
    latestQuestions.current = data.questions;
    setQuestions(data.questions);
    setImages(data.images);
    setSaveState("saved");
  }

  useEffect(() => {
    setStoredAdminKey(readAdminKey());
  }, []);

  useEffect(() => {
    if (!adminKey) return;
    loadQuestions().catch((loadError: unknown) => {
      console.error("Failed to load room questions", loadError);
      setError(
        loadError instanceof Error && loadError.message === "unauthorized"
          ? "Invalid admin key."
          : "Could not load questions."
      );
    });
    adminFetch("/api/admin/rooms", adminKey)
      .then(async (response) => (response.ok ? ((await response.json()) as Array<{ name: string }>) : []))
      .then((rows) => {
        const names = new Set([DEFAULT_ROOM_NAME, ...rows.map((row) => row.name)]);
        names.delete(room);
        setOtherRooms(Array.from(names).sort());
      })
      .catch((roomsError: unknown) => console.error("Failed to load rooms", roomsError));
    fetch(getRoomSettingsEndpoint(room), { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        setAskPlayMode(parseRoomSettings(await response.json()).askPlayMode);
      })
      .catch((settingsError: unknown) => console.error("Failed to load room settings", settingsError));
  }, [room, adminKey]);

  async function changeAskPlayMode(next: boolean) {
    setAskPlayMode(next);
    setError(null);
    try {
      const response = await adminFetch(getAdminRoomSettingsEndpoint(room), adminKey, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ askPlayMode: next }),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    } catch (settingsError) {
      console.error("Failed to save room settings", settingsError);
      setAskPlayMode(!next);
      setError("Could not save the room setting.");
    }
  }

  useEffect(() => {
    if (saveState === "saved") return;
    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [saveState]);

  async function saveNow() {
    saveTimer.current = null;
    const versionAtSave = changeVersion.current;
    try {
      const response = await adminFetch(getRoomQuestionsEndpoint(room), adminKey, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questions: latestQuestions.current }),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        setSaveState("failed");
        setError(readErrorMessage(body, "Could not save questions."));
        return;
      }
      if (changeVersion.current === versionAtSave) {
        setSaveState("saved");
        setError(null);
      }
    } catch (saveError) {
      console.error("Failed to save room questions", saveError);
      setSaveState("failed");
      setError("Could not save. Check your connection.");
    }
  }

  /** Every edit goes through here: update the screen now, save shortly after if the list is valid. */
  function updateQuestions(next: PollQuestion[]) {
    latestQuestions.current = next;
    changeVersion.current += 1;
    setQuestions(next);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (next.some((question) => getQuestionIssue(question) !== null)) {
      setSaveState("invalid");
      return;
    }
    setSaveState("saving");
    saveTimer.current = window.setTimeout(() => void saveNow(), AUTOSAVE_DELAY_MS);
  }

  function updateQuestion(questionId: string, update: (question: PollQuestion) => PollQuestion) {
    updateQuestions(
      latestQuestions.current.map((question) => (question.id === questionId ? update(question) : question))
    );
  }

  function setOptionImage(questionId: string, optionId: string, image: StoredOptionImage | null) {
    setImages((current) => {
      const forQuestion = { ...current[questionId] };
      if (image) {
        forQuestion[optionId] = image;
      } else {
        delete forQuestion[optionId];
      }
      return { ...current, [questionId]: forQuestion };
    });
  }

  async function replaceQuestions(source: ReplaceQuestionsSource, sourceName: string) {
    if (!confirm(`Replace every question in ${room} with ${sourceName}? Votes on removed questions are cleared.`)) {
      return;
    }
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    setError(null);
    try {
      const response = await adminFetch(`${getRoomQuestionsEndpoint(room)}/replace`, adminKey, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(source),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        setError(readErrorMessage(body, "Could not replace questions."));
        return;
      }
      changeVersion.current += 1;
      await loadQuestions();
    } catch (replaceError) {
      console.error("Failed to replace room questions", replaceError);
      setError("Could not replace questions.");
    }
  }

  function onReplaceSelect(value: string) {
    if (value === "starter") void replaceQuestions({ kind: "starter" }, "the starter questions");
    if (value === "empty") void replaceQuestions({ kind: "empty" }, "nothing");
    if (value.startsWith("room:")) {
      const sourceRoom = value.slice("room:".length);
      void replaceQuestions({ kind: "room", room: sourceRoom }, `a copy of ${sourceRoom}`);
    }
  }

  return (
    <main className="app admin-app question-editor">
      <header className="admin-header">
        <div>
          <h1>{room}</h1>
          <p className="muted">
            <a href="/admin/">Room Admin</a>
            {questions ? ` · ${questions.length} question${questions.length === 1 ? "" : "s"}` : ""}
          </p>
        </div>
        {questions ? (
          <div className="question-editor-header-tools">
            <span className={`question-editor-status is-${saveState}`} aria-live="polite">
              {SAVE_STATE_LABEL[saveState]}
            </span>
            <select
              className="question-editor-replace"
              aria-label="Replace questions"
              value=""
              onChange={(event) => onReplaceSelect(event.currentTarget.value)}
            >
              <option value="" disabled>
                Replace with…
              </option>
              <option value="starter">Starter questions</option>
              {otherRooms.map((name) => (
                <option key={name} value={`room:${name}`}>
                  Copy of {name}
                </option>
              ))}
              <option value="empty">No questions</option>
            </select>
          </div>
        ) : null}
      </header>

      {storedAdminKey === "" ? (
        <p className="error">
          <a href="/admin/">Log in to Room Admin</a> first.
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}

      {askPlayMode !== null ? (
        <label className="question-editor-check">
          <input
            type="checkbox"
            checked={askPlayMode}
            onChange={(event) => void changeAskPlayMode(event.currentTarget.checked)}
          />
          Ask players: in person or online
        </label>
      ) : null}

      {questions ? (
        <>
          <ol className="question-editor-list">
            {questions.map((question, index) => {
              const issue = getQuestionIssue(question);
              return (
                <li key={question.id} className={`panel question-editor-card ${issue ? "has-issue" : ""}`}>
                  <div className="question-editor-head">
                    <span className="admin-question-index">Q{index + 1}</span>
                    <select
                      aria-label="Question type"
                      value={getQuestionType(question)}
                      onChange={(event) => {
                        const type = parseQuestionType(event.currentTarget.value);
                        updateQuestion(question.id, (current) => changeQuestionType(current, type));
                      }}
                    >
                      <option value="text">Text answers</option>
                      <option value="image">Image answers</option>
                      <option value="number">Number guess</option>
                    </select>
                    <div className="question-editor-tools">
                      <button
                        type="button"
                        className="admin-icon-btn"
                        aria-label="Move up"
                        disabled={index === 0}
                        onClick={() => updateQuestions(moveItem(latestQuestions.current, index, index - 1))}
                      >
                        <ArrowUp size={14} strokeWidth={2} aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="admin-icon-btn"
                        aria-label="Move down"
                        disabled={index === questions.length - 1}
                        onClick={() => updateQuestions(moveItem(latestQuestions.current, index, index + 1))}
                      >
                        <ArrowDown size={14} strokeWidth={2} aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="admin-icon-btn admin-action-delete"
                        aria-label={`Delete question ${index + 1}`}
                        onClick={() => {
                          if (question.prompt.trim() && !confirm(`Delete "${question.prompt}"?`)) return;
                          updateQuestions(latestQuestions.current.filter((item) => item.id !== question.id));
                        }}
                      >
                        <Trash2 size={13} strokeWidth={2} aria-hidden />
                      </button>
                    </div>
                  </div>

                  <input
                    className="text-input question-editor-prompt"
                    aria-label={`Question ${index + 1}`}
                    placeholder="Question"
                    value={question.prompt}
                    onChange={(event) => {
                      const prompt = event.currentTarget.value;
                      updateQuestion(question.id, (current) => ({ ...current, prompt }));
                    }}
                  />

                  {question.kind === "choice" ? (
                    <ChoiceFields
                      room={room}
                      adminKey={adminKey}
                      question={question}
                      images={images[question.id] ?? {}}
                      onChange={(next) => updateQuestion(question.id, () => next)}
                      onImageChange={(optionId, image) => setOptionImage(question.id, optionId, image)}
                      onError={setError}
                    />
                  ) : (
                    <NumberFields
                      question={question}
                      onChange={(next) => updateQuestion(question.id, () => next)}
                    />
                  )}

                  {issue ? <p className="question-editor-issue">{issue}</p> : null}
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            className="admin-action-btn question-editor-add"
            onClick={() => updateQuestions([...latestQuestions.current, createQuestion("text")])}
          >
            <Plus size={14} strokeWidth={2} aria-hidden /> Add question
          </button>
        </>
      ) : null}

      <footer className="app-bottom-bar">
        <span className="app-bottom-left">SynHole Admin</span>
        <div className="app-bottom-right">
          <span>Room: {room}</span>
        </div>
      </footer>
    </main>
  );
}

function ChoiceFields(props: {
  room: string;
  adminKey: string;
  question: PollChoiceQuestion;
  images: Record<string, StoredOptionImage>;
  onChange: (question: PollChoiceQuestion) => void;
  onImageChange: (optionId: string, image: StoredOptionImage | null) => void;
  onError: (message: string) => void;
}) {
  const { room, adminKey, question, images, onChange, onImageChange, onError } = props;
  const isImage = question.display === "image";

  function toggleCorrect(optionId: string) {
    const isCorrect = question.correctOptionIds.includes(optionId);
    const correctOptionIds = question.allowMultiple
      ? isCorrect
        ? question.correctOptionIds.filter((id) => id !== optionId)
        : [...question.correctOptionIds, optionId]
      : isCorrect
        ? []
        : [optionId];
    onChange({ ...question, correctOptionIds });
  }

  return (
    <>
      <div className={isImage ? "question-editor-image-options" : "question-editor-options"}>
        {question.options.map((option, optionIndex) => {
          const optionName = getOptionName(optionIndex);
          const isCorrect = question.correctOptionIds.includes(option.id);
          return (
            <div key={option.id} className={`question-editor-option ${isCorrect ? "is-correct" : ""}`}>
              {isImage ? (
                <OptionImageSlot
                  room={room}
                  questionId={question.id}
                  optionId={option.id}
                  optionName={optionName}
                  description={option.label}
                  image={images[option.id]}
                  adminKey={adminKey}
                  onImageChange={(image) => onImageChange(option.id, image)}
                  onError={onError}
                />
              ) : null}
              <div className="question-editor-option-row">
                <button
                  type="button"
                  className="question-editor-correct"
                  aria-pressed={isCorrect}
                  aria-label={`${optionName} is correct`}
                  title="Correct answer"
                  onClick={() => toggleCorrect(option.id)}
                >
                  <Check size={14} strokeWidth={2.4} aria-hidden />
                </button>
                <input
                  className="text-input"
                  aria-label={isImage ? `${optionName} description` : optionName}
                  placeholder={isImage ? "Image description" : optionName}
                  value={option.label}
                  onChange={(event) => {
                    const label = event.currentTarget.value;
                    onChange({
                      ...question,
                      options: question.options.map((item) => (item.id === option.id ? { ...item, label } : item)),
                    });
                  }}
                />
                <button
                  type="button"
                  className="admin-icon-btn"
                  aria-label={`Remove ${optionName}`}
                  disabled={question.options.length <= 2}
                  onClick={() =>
                    onChange({
                      ...question,
                      options: question.options.filter((item) => item.id !== option.id),
                      correctOptionIds: question.correctOptionIds.filter((id) => id !== option.id),
                    })
                  }
                >
                  <X size={13} strokeWidth={2} aria-hidden />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="question-editor-settings">
        <button
          type="button"
          className="admin-action-btn"
          onClick={() => onChange({ ...question, options: [...question.options, createOption()] })}
        >
          <Plus size={13} strokeWidth={2} aria-hidden /> Add option
        </button>
        <label className="question-editor-check">
          <input
            type="checkbox"
            checked={question.allowMultiple}
            onChange={(event) => onChange({ ...question, allowMultiple: event.currentTarget.checked })}
          />
          Multiple answers
        </label>
        <label className="question-editor-check">
          <input
            type="checkbox"
            checked={question.hideResultsUntilReveal === true}
            onChange={(event) =>
              onChange({ ...question, hideResultsUntilReveal: event.currentTarget.checked })
            }
          />
          Hide results until reveal
        </label>
      </div>
    </>
  );
}

function NumberFields(props: {
  question: PollNumberQuestion;
  onChange: (question: PollNumberQuestion) => void;
}) {
  const { question, onChange } = props;
  return (
    <div className="question-editor-number">
      <label className="admin-field-label">
        Correct number
        <input
          className="text-input"
          type="number"
          value={Number.isFinite(question.correctNumber) ? question.correctNumber : ""}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onChange({ ...question, correctNumber: value.trim() === "" ? Number.NaN : Number(value) });
          }}
        />
      </label>
      <label className="admin-field-label">
        Lowest
        <input
          className="text-input"
          type="number"
          value={question.min ?? ""}
          onChange={(event) => onChange({ ...question, min: parseOptionalNumber(event.currentTarget.value) })}
        />
      </label>
      <label className="admin-field-label">
        Highest
        <input
          className="text-input"
          type="number"
          value={question.max ?? ""}
          onChange={(event) => onChange({ ...question, max: parseOptionalNumber(event.currentTarget.value) })}
        />
      </label>
      <label className="question-editor-check">
        <input
          type="checkbox"
          checked={question.hideResultsUntilReveal === true}
          onChange={(event) => onChange({ ...question, hideResultsUntilReveal: event.currentTarget.checked })}
        />
        Hide results until reveal
      </label>
    </div>
  );
}
