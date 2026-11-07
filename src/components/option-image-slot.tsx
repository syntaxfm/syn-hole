import { useState } from "react";
import { Trash2, Upload } from "lucide-react";
import type { StoredOptionImage } from "~/types";
import { adminFetch } from "~/utils/admin-api";
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

/** One option's image: pick or drop to upload at once (with progress), or remove. */
export function OptionImageSlot(props: {
  room: string;
  questionId: string;
  optionId: string;
  optionName: string;
  description: string;
  image: StoredOptionImage | undefined;
  adminKey: string;
  onImageChange: (image: StoredOptionImage | null) => void;
  onError: (message: string) => void;
}) {
  const { room, questionId, optionId, optionName, description, image, adminKey, onImageChange, onError } =
    props;
  const [upload, setUpload] = useState<SlotUpload | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const imageUrl = upload?.previewUrl ?? image?.url;

  async function uploadImage(file: File) {
    if (!isPollImageContentType(file.type)) {
      onError("Use a JPEG, PNG, WebP, GIF or AVIF image.");
      return;
    }
    if (file.size > MAX_POLL_IMAGE_BYTES) {
      onError("Image is larger than 10 MB.");
      return;
    }

    let dimensions: { width: number; height: number };
    try {
      dimensions = await readImageDimensions(file);
    } catch (readError) {
      console.error("Failed to read image dimensions", readError);
      onError("Could not read that image.");
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    setUpload({ progress: 0, previewUrl });
    try {
      const result = await uploadWithProgress({
        method: "PUT",
        url: getAdminPollImageEndpoint(room, questionId, optionId),
        body: file,
        headers: {
          "content-type": file.type,
          "x-admin-key": adminKey,
          "x-image-width": String(dimensions.width),
          "x-image-height": String(dimensions.height),
        },
        onProgress: (progress) => setUpload((current) => (current ? { ...current, progress } : current)),
      });
      if (result.status < 200 || result.status >= 300 || !isAdminPollImageUploadResponse(result.body)) {
        onError(readErrorMessage(result.body, "Upload failed."));
        return;
      }
      onImageChange(result.body.image);
    } catch (uploadError) {
      console.error("Poll image upload failed", uploadError);
      onError("Upload failed. Check your connection.");
    } finally {
      URL.revokeObjectURL(previewUrl);
      setUpload(null);
    }
  }

  async function removeImage() {
    if (!confirm(`Remove the image for ${optionName}?`)) return;
    try {
      const response = await adminFetch(getAdminPollImageEndpoint(room, questionId, optionId), adminKey, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      onImageChange(null);
    } catch (deleteError) {
      console.error("Poll image delete failed", deleteError);
      onError("Could not remove that image.");
    }
  }

  return (
    <label
      className={`admin-image-slot ${imageUrl ? "" : "is-empty"} ${isDragOver ? "is-dragover" : ""} ${
        upload ? "is-uploading" : ""
      }`}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setIsDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragOver(false);
        const file = event.dataTransfer.files[0];
        if (file && !upload) void uploadImage(file);
      }}
    >
      {imageUrl ? (
        <img src={imageUrl} width={image?.width} height={image?.height} alt={description} />
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
        ) : image ? (
          <span>{formatFileSize(image.size)}</span>
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
          if (file) void uploadImage(file);
        }}
      />
      {image && !upload ? (
        <button
          type="button"
          className="admin-icon-btn"
          aria-label={`Remove image for ${optionName}`}
          title="Remove image"
          onClick={(event) => {
            event.preventDefault();
            void removeImage();
          }}
        >
          <Trash2 size={13} strokeWidth={2} aria-hidden />
        </button>
      ) : null}
    </label>
  );
}
