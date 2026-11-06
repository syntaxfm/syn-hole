import { useEffect, useState } from "react";
import type { DragEvent } from "react";
import { Image as ImageIcon, Trash2, Upload } from "lucide-react";
import type { AdminPollImageOption, AdminPollImageQuestion } from "~/types";
import { formatFileSize, readErrorMessage, uploadWithProgress } from "~/utils/files";
import {
  MAX_POLL_IMAGE_BYTES,
  POLL_IMAGE_CONTENT_TYPES,
  getAdminPollImageEndpoint,
  isAdminPollImageUploadResponse,
  isPollImageContentType,
  readImageDimensions,
} from "~/utils/poll-images";

type SlotUpload = {
  progress: number;
  previewUrl: string;
};

export function AdminPollImages(props: { adminKey: string }) {
  const { adminKey } = props;
  const [questions, setQuestions] = useState<AdminPollImageQuestion[]>([]);
  const [uploads, setUploads] = useState<Record<string, SlotUpload>>({});
  const [dragOverSlot, setDragOverSlot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/images", { headers: { "x-admin-key": adminKey } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return (await response.json()) as AdminPollImageQuestion[];
      })
      .then((data) => {
        if (!cancelled) setQuestions(data);
      })
      .catch((loadError: unknown) => {
        console.error("Failed to load poll images", loadError);
        if (!cancelled) setError("Could not load poll images.");
      });
    return () => {
      cancelled = true;
    };
  }, [adminKey]);

  function setOptionImage(
    questionId: string,
    optionId: string,
    image: AdminPollImageOption["image"]
  ) {
    setQuestions((current) =>
      current.map((question) =>
        question.id !== questionId
          ? question
          : {
              ...question,
              options: question.options.map((option) =>
                option.id === optionId ? { ...option, image } : option
              ),
            }
      )
    );
  }

  function clearUpload(slotKey: string) {
    setUploads((current) => {
      const upload = current[slotKey];
      if (upload) URL.revokeObjectURL(upload.previewUrl);
      const { [slotKey]: _removed, ...rest } = current;
      return rest;
    });
  }

  async function uploadImage(questionId: string, optionId: string, file: File) {
    setError(null);
    if (!isPollImageContentType(file.type)) {
      setError("Use a JPEG, PNG, WebP, GIF or AVIF image.");
      return;
    }
    if (file.size > MAX_POLL_IMAGE_BYTES) {
      setError("Image is larger than 10 MB.");
      return;
    }

    let dimensions: { width: number; height: number };
    try {
      dimensions = await readImageDimensions(file);
    } catch (readError) {
      console.error("Failed to read image dimensions", readError);
      setError("Could not read that image.");
      return;
    }

    const slotKey = `${questionId}/${optionId}`;
    setUploads((current) => ({
      ...current,
      [slotKey]: { progress: 0, previewUrl: URL.createObjectURL(file) },
    }));

    try {
      const result = await uploadWithProgress({
        method: "PUT",
        url: getAdminPollImageEndpoint(questionId, optionId),
        body: file,
        headers: {
          "content-type": file.type,
          "x-admin-key": adminKey,
          "x-image-width": String(dimensions.width),
          "x-image-height": String(dimensions.height),
        },
        onProgress: (progress) =>
          setUploads((current) =>
            current[slotKey] ? { ...current, [slotKey]: { ...current[slotKey], progress } } : current
          ),
      });
      if (result.status < 200 || result.status >= 300 || !isAdminPollImageUploadResponse(result.body)) {
        setError(readErrorMessage(result.body, "Upload failed."));
        return;
      }
      setOptionImage(questionId, optionId, result.body.image);
    } catch (uploadError) {
      console.error("Poll image upload failed", uploadError);
      setError("Upload failed. Check your connection.");
    } finally {
      clearUpload(slotKey);
    }
  }

  async function deleteImage(questionId: string, optionId: string, optionName: string) {
    if (!confirm(`Remove the image for ${optionName}?`)) return;
    setError(null);
    try {
      const response = await fetch(getAdminPollImageEndpoint(questionId, optionId), {
        method: "DELETE",
        headers: { "x-admin-key": adminKey },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      setOptionImage(questionId, optionId, null);
    } catch (deleteError) {
      console.error("Poll image delete failed", deleteError);
      setError("Could not remove that image.");
    }
  }

  function onSlotDragLeave(event: DragEvent<HTMLLabelElement>, slotKey: string) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setDragOverSlot((current) => (current === slotKey ? null : current));
  }

  if (questions.length === 0 && !error) return null;

  return (
    <section className="panel admin-images-card">
      <h3>
        <ImageIcon size={18} strokeWidth={2} aria-hidden /> Poll Images
      </h3>
      {error ? <p className="error">{error}</p> : null}
      <div className="admin-image-questions">
        {questions.map((question) => {
          const filledCount = question.options.filter((option) => option.image).length;
          const isComplete = filledCount === question.options.length;
          return (
            <div className="admin-image-question" key={question.id}>
              <div className="admin-image-question-head">
                <span className="admin-question-index">Q{question.index + 1}</span>
                <strong>{question.prompt}</strong>
                <span className={`admin-question-phase ${isComplete ? "phase-open" : "phase-closed"}`}>
                  {filledCount}/{question.options.length}
                </span>
              </div>
              <div className="admin-image-slots">
                {question.options.map((option, optionIndex) => {
                  const slotKey = `${question.id}/${option.id}`;
                  const upload = uploads[slotKey];
                  const imageUrl = upload?.previewUrl ?? option.image?.url;
                  const isCorrect = question.correctOptionIds.includes(option.id);
                  const isDragOver = dragOverSlot === slotKey;
                  const optionName = `Option ${String.fromCharCode(65 + (optionIndex % 26))}`;
                  return (
                    <label
                      key={option.id}
                      className={`admin-image-slot ${imageUrl ? "" : "is-empty"} ${
                        isDragOver ? "is-dragover" : ""
                      } ${upload ? "is-uploading" : ""}`}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDragOverSlot(slotKey);
                      }}
                      onDragLeave={(event) => onSlotDragLeave(event, slotKey)}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDragOverSlot(null);
                        const file = event.dataTransfer.files[0];
                        if (file && !upload) void uploadImage(question.id, option.id, file);
                      }}
                    >
                      {imageUrl ? (
                        <img
                          src={imageUrl}
                          width={option.image?.width}
                          height={option.image?.height}
                          alt={option.label}
                        />
                      ) : (
                        <span className="admin-image-slot-empty">
                          <Upload size={18} strokeWidth={2} aria-hidden />
                          {isDragOver ? "Drop image" : "Add image"}
                        </span>
                      )}
                      {upload ? (
                        <span className="admin-image-progress">
                          <span style={{ width: `${upload.progress}%` }} />
                        </span>
                      ) : null}
                      <span className="admin-image-slot-meta">
                        {optionName}
                        {upload ? (
                          <span>{upload.progress}%</span>
                        ) : isCorrect ? (
                          <span className="audience-option-badge badge-selected-correct">Correct</span>
                        ) : option.image ? (
                          <span>{formatFileSize(option.image.size)}</span>
                        ) : null}
                      </span>
                      <input
                        type="file"
                        accept={POLL_IMAGE_CONTENT_TYPES.join(",")}
                        aria-label={`Upload image for ${optionName}`}
                        disabled={Boolean(upload)}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = "";
                          if (file) void uploadImage(question.id, option.id, file);
                        }}
                      />
                      {option.image && !upload ? (
                        <button
                          type="button"
                          className="admin-icon-btn"
                          aria-label={`Remove image for ${optionName}`}
                          title="Remove image"
                          onClick={(event) => {
                            event.preventDefault();
                            void deleteImage(question.id, option.id, optionName);
                          }}
                        >
                          <Trash2 size={13} strokeWidth={2} aria-hidden />
                        </button>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
