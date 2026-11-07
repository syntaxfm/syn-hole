import type { PlayMode, RoomSettings } from "~/types";

export const PLAY_MODES: PlayMode[] = ["in-person", "online"];

/** Players the room has no answer for (joined before it asked) count as in person. */
export const DEFAULT_PLAY_MODE: PlayMode = "in-person";

export const PLAY_MODE_LABEL: Record<PlayMode, string> = {
  "in-person": "In person",
  online: "Online",
};

const PLAY_MODE_STORAGE_PREFIX = "syntax-live-play-mode:";

export function isPlayMode(value: unknown): value is PlayMode {
  return value === "in-person" || value === "online";
}

export function parseRoomSettings(raw: unknown): RoomSettings {
  if (!raw || typeof raw !== "object" || !("askPlayMode" in raw) || typeof raw.askPlayMode !== "boolean") {
    throw new TypeError("Settings must include askPlayMode as true or false.");
  }
  return { askPlayMode: raw.askPlayMode };
}

export function getRoomSettingsEndpoint(room: string): string {
  return `/api/rooms/${encodeURIComponent(room)}/settings`;
}

/** Remembered per room, so a new room asks again. */
export function readPlayMode(room: string): PlayMode | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(PLAY_MODE_STORAGE_PREFIX + room);
  return isPlayMode(stored) ? stored : null;
}

export function savePlayMode(room: string, playMode: PlayMode) {
  if (typeof window !== "undefined") window.localStorage.setItem(PLAY_MODE_STORAGE_PREFIX + room, playMode);
}
