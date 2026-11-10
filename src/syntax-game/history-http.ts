import { historyId, historyPagination } from "~/syntax-game/history";
import type { SyntaxRuntimeStore } from "./storage-runtime";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

/** Called only by the worker's authenticated forwarding path. Never proxy a
 * user-supplied internal URL or accept external PartyServer HTTP requests. */
export async function routeSyntaxHistoryHttp(request: Request, deps: {
  checkAdminAuth: (request: Request) => Response | null;
  roomFetch: (room: string, path: string) => Promise<Response>;
}): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/admin\/rooms\/([^/]+)\/syntax\/history(?:\/([^/]+))?\/?$/);
  if (!match) return null;
  const denied = deps.checkAdminAuth(request);
  if (denied) return denied;
  const room = historyId(match[1]);
  const gameId = match[2] === undefined ? undefined : historyId(match[2]);
  if (!room || gameId === null) return json({ error: "Invalid room or game ID." }, 400);
  if (request.method !== "GET") return json({ error: "History is read-only." }, 405);
  if (!historyPagination(url.searchParams)) return json({ error: "Invalid pagination." }, 400);
  const params = new URLSearchParams();
  for (const key of ["limit", "offset"]) {
    const value = url.searchParams.get(key);
    if (value !== null && !gameId) params.set(key, value);
  }
  // In particular, never forward query-string admin credentials to the room.
  const query = params.size ? `?${params}` : "";
  return deps.roomFetch(room, `/syntax/history${gameId ? `/${gameId}` : ""}${query}`);
}

export function handleInternalSyntaxHistory(request: Request, store: SyntaxRuntimeStore): Response {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/syntax\/history(?:\/([^/]+))?$/);
  if (!match) return json({ error: "Not found." }, 404);
  if (request.method !== "GET") return json({ error: "History is read-only." }, 405);
  if (match[1]) {
    const id = historyId(match[1]);
    if (!id) return json({ error: "Invalid game ID." }, 400);
    const session = store.history(id);
    return session ? json({ session }) : json({ error: "Game not found." }, 404);
  }
  const page = historyPagination(url.searchParams);
  return page ? json(store.listHistory(page)) : json({ error: "Invalid pagination." }, 400);
}
