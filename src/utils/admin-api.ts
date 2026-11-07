const ADMIN_KEY_STORAGE_KEY = "syntax-live-admin-key";

/** Prefers ?adminKey= (and remembers it), then the stored key. */
export function readAdminKey(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  const urlKey = params.get("adminKey") ?? params.get("key");
  if (urlKey) {
    window.localStorage.setItem(ADMIN_KEY_STORAGE_KEY, urlKey);
    return urlKey;
  }
  return window.localStorage.getItem(ADMIN_KEY_STORAGE_KEY) ?? "";
}

export function saveAdminKey(value: string) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(ADMIN_KEY_STORAGE_KEY, value);
  }
}

export function adminFetch(path: string, adminKey: string, options?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...options,
    headers: {
      ...options?.headers,
      "x-admin-key": adminKey,
    },
  });
}

export function getRoomQuestionsEndpoint(room: string): string {
  return `/api/admin/rooms/${encodeURIComponent(room)}/questions`;
}

export function getAdminRoomSettingsEndpoint(room: string): string {
  return `/api/admin/rooms/${encodeURIComponent(room)}/settings`;
}
