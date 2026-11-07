import handler from "@tanstack/react-start/server-entry";
import { routePartykitRequest } from "partyserver";
import { STARTER_QUESTIONS } from "./poll-room";
import { copyRoomImages, deletePollImage, servePollImage, uploadPollImage } from "./poll-images";
import type { PollQuestion, ReplaceQuestionsSource, RoomQuestionsResponse } from "./types";
import { isSafeKeySegment } from "./utils/poll-images";

export { PollRoom } from "./poll-room";
export { AdminRegistry } from "./admin-registry";

function getRole(role: string | null): "host" | "projector" | "audience" {
  if (role === "host" || role === "projector") return role;
  return "audience";
}

function getAdminKey(env: Env): string | undefined {
  return "ADMIN_KEY" in env ? (env as { ADMIN_KEY?: string }).ADMIN_KEY : undefined;
}

function checkAdminAuth(request: Request, env: Env): Response | null {
  const adminKey = getAdminKey(env);
  if (!adminKey) {
    return new Response("ADMIN_KEY not configured", { status: 500 });
  }
  const authHeader = request.headers.get("x-admin-key") ?? "";
  const url = new URL(request.url);
  const queryKey = url.searchParams.get("adminKey") ?? "";
  if (authHeader !== adminKey && queryKey !== adminKey) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

/** Calls a room's Durable Object directly. partyserver needs the room name in this header. */
function fetchRoom(env: Env, roomName: string, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("x-partykit-room", roomName);
  return env.PollRoom.get(env.PollRoom.idFromName(roomName)).fetch(
    new Request(`http://internal${path}`, { ...init, headers })
  );
}

function getRegistryStub(env: Env): DurableObjectStub {
  const id = env.AdminRegistry.idFromName("global");
  return env.AdminRegistry.get(id);
}

async function lookupRoomHostKey(env: Env, roomName: string): Promise<string | null> {
  const stub = getRegistryStub(env);
  const resp = await stub.fetch(
    new Request(`http://internal/rooms/${encodeURIComponent(roomName)}/host-key`)
  );
  const data = (await resp.json()) as { found: boolean; hostKey?: string };
  return data.found && data.hostKey ? data.hostKey : null;
}

async function lookupRoomStartAt(env: Env, roomName: string): Promise<string | null> {
  const stub = getRegistryStub(env);
  const resp = await stub.fetch(
    new Request(`http://internal/rooms/${encodeURIComponent(roomName)}/start-time`)
  );
  const data = (await resp.json()) as { found: boolean; startAt?: string | null };
  if (!data.found) return null;
  return typeof data.startAt === "string" && data.startAt.length > 0 ? data.startAt : null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/bootstrap") {
      if (request.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "cache-control": "no-store" },
        });
      }
      if (request.method === "GET") {
        const city = (request.cf as { city?: string } | undefined)?.city?.trim();
        const defaultAudienceName =
          city && city.length > 0 ? `Anon from ${city}` : "Anon from somewhere";
        return Response.json(
          { defaultAudienceName },
          { headers: { "cache-control": "no-store" } }
        );
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    const roomStartTimeMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/start-time$/);
    if (roomStartTimeMatch && request.method === "GET") {
      const roomName = decodeURIComponent(roomStartTimeMatch[1]);
      const startAt = await lookupRoomStartAt(env, roomName);
      return Response.json(
        { room: roomName, startAt },
        { headers: { "cache-control": "no-store" } }
      );
    }

    // The join screen needs these before the player connects.
    const roomSettingsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/settings$/);
    if (roomSettingsMatch && request.method === "GET") {
      const roomName = decodeURIComponent(roomSettingsMatch[1]);
      if (!isSafeKeySegment(roomName)) {
        return Response.json({ error: "Invalid room name." }, { status: 400 });
      }
      return fetchRoom(env, roomName, "/settings");
    }

    const pollImageMatch = url.pathname.match(/^\/api\/images\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (pollImageMatch && request.method === "GET") {
      return servePollImage(
        env.POLL_IMAGES,
        decodeURIComponent(pollImageMatch[1]),
        decodeURIComponent(pollImageMatch[2]),
        decodeURIComponent(pollImageMatch[3])
      );
    }

    // Rooms are only reachable over WebSocket from outside. Their HTTP endpoints
    // (questions, reset, stats) are internal and go through the admin API below.
    if (
      url.pathname.startsWith("/parties/") &&
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("Not Found", { status: 404 });
    }

    if (url.pathname.startsWith("/api/admin")) {
      return handleAdminApi(request, env, url);
    }

    const hostKeyFromEnv =
      "HOST_KEY" in env ? (env as { HOST_KEY?: string }).HOST_KEY : undefined;
    const partyResponse = await routePartykitRequest(request, env, {
      async onBeforeConnect(req) {
        const reqUrl = new URL(req.url);
        const role = getRole(reqUrl.searchParams.get("role"));
        if (role !== "host") return;

        const roomName = reqUrl.pathname.split("/").filter(Boolean).pop() ?? "";
        const roomSpecificKey = await lookupRoomHostKey(env, roomName);
        const effectiveHostKey = roomSpecificKey ?? hostKeyFromEnv;

        if (!effectiveHostKey) {
          return new Response("HOST_KEY is not configured for this worker.", {
            status: 500,
          });
        }

        const hostKey =
          reqUrl.searchParams.get("hostKey") ?? reqUrl.searchParams.get("key") ?? "";
        if (hostKey !== effectiveHostKey) {
          return new Response("Unauthorized host key.", { status: 401 });
        }
      },
    });

    if (partyResponse) return partyResponse;

    return handler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

async function handleAdminApi(request: Request, env: Env, url: URL): Promise<Response> {
  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  const path = url.pathname.replace(/^\/api\/admin/, "");

  if (path === "/rooms" && request.method === "GET") {
    return getRegistryStub(env).fetch(new Request("http://internal/rooms"));
  }

  if (path === "/rooms" && request.method === "POST") {
    return getRegistryStub(env).fetch(
      new Request("http://internal/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await request.text(),
      })
    );
  }

  const roomMatch = path.match(/^\/rooms\/([^/]+)(\/.*)?$/);
  if (!roomMatch) return new Response("Not Found", { status: 404 });

  const roomName = decodeURIComponent(roomMatch[1]);
  const roomPath = roomMatch[2] ?? "";

  if (roomPath === "" && request.method === "DELETE") {
    return getRegistryStub(env).fetch(
      new Request(`http://internal/rooms/${encodeURIComponent(roomName)}`, { method: "DELETE" })
    );
  }

  if (!isSafeKeySegment(roomName)) {
    return Response.json({ error: "Invalid room name." }, { status: 400 });
  }

  if (roomPath === "/stats" && request.method === "GET") {
    return fetchRoom(env, roomName, "/stats");
  }

  if (roomPath === "/reset" && request.method === "POST") {
    return fetchRoom(env, roomName, "/reset", { method: "POST" });
  }

  if (roomPath === "/settings" && request.method === "PUT") {
    return fetchRoom(env, roomName, "/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: await request.text(),
    });
  }

  if (roomPath === "/questions" && request.method === "GET") {
    return fetchRoom(env, roomName, "/questions");
  }

  if (roomPath === "/questions" && request.method === "PUT") {
    return fetchRoom(env, roomName, "/questions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: await request.text(),
    });
  }

  if (roomPath === "/questions/replace" && request.method === "POST") {
    return replaceRoomQuestions(env, roomName, await request.json().catch(() => null));
  }

  const imageMatch = roomPath.match(/^\/images\/([^/]+)\/([^/]+)$/);
  if (imageMatch && (request.method === "PUT" || request.method === "DELETE")) {
    const questionId = decodeURIComponent(imageMatch[1]);
    const optionId = decodeURIComponent(imageMatch[2]);
    const response =
      request.method === "PUT"
        ? await uploadPollImage(env.POLL_IMAGES, roomName, questionId, optionId, request)
        : await deletePollImage(env.POLL_IMAGES, roomName, questionId, optionId);
    if (response.ok) {
      // Best effort: the upload already succeeded even if the room can't be reached.
      await fetchRoom(env, roomName, "/images-changed", { method: "POST" }).catch(
        (error: unknown) => console.error("Failed to notify room about image change", error)
      );
    }
    return response;
  }

  return new Response("Not Found", { status: 404 });
}

function parseReplaceSource(body: unknown): ReplaceQuestionsSource | null {
  if (!body || typeof body !== "object" || !("kind" in body)) return null;
  if (body.kind === "starter" || body.kind === "empty") return { kind: body.kind };
  if (body.kind === "room" && "room" in body && typeof body.room === "string") {
    return isSafeKeySegment(body.room) ? { kind: "room", room: body.room } : null;
  }
  return null;
}

/** Replaces a room's questions (and, when copying a room, its images) in one admin action. */
async function replaceRoomQuestions(env: Env, roomName: string, body: unknown): Promise<Response> {
  const source = parseReplaceSource(body);
  if (!source) return Response.json({ error: "Unknown source." }, { status: 400 });
  if (source.kind === "room" && source.room === roomName) {
    return Response.json({ error: "Pick a different room to copy from." }, { status: 400 });
  }

  let questions: PollQuestion[] = [];
  if (source.kind === "starter") questions = STARTER_QUESTIONS;
  if (source.kind === "room") {
    const sourceResponse = await fetchRoom(env, source.room, "/questions");
    if (!sourceResponse.ok) {
      return Response.json({ error: "Could not read that room's questions." }, { status: 502 });
    }
    questions = ((await sourceResponse.json()) as RoomQuestionsResponse).questions;
    await copyRoomImages(env.POLL_IMAGES, source.room, roomName);
  }

  return fetchRoom(env, roomName, "/questions", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ questions }),
  });
}
