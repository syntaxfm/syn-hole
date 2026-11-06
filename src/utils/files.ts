export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type UploadResult = {
  status: number;
  body: unknown;
};

/** fetch() can't report upload progress, so this uses XMLHttpRequest. Progress is 0–100. */
export function uploadWithProgress(options: {
  method: "PUT" | "POST";
  url: string;
  body: Blob;
  headers: Record<string, string>;
  onProgress: (percent: number) => void;
}): Promise<UploadResult> {
  const { method, url, body, headers, onProgress } = options;
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, url);
    for (const [name, value] of Object.entries(headers)) {
      request.setRequestHeader(name, value);
    }
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(request.responseText);
      } catch {
        parsed = request.responseText;
      }
      resolve({ status: request.status, body: parsed });
    });
    request.addEventListener("error", () => reject(new Error("Network error during upload.")));
    request.addEventListener("abort", () => reject(new Error("Upload was cancelled.")));
    request.send(body);
  });
}

/** Pulls `error` out of a JSON error body, or falls back. */
export function readErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return fallback;
}
