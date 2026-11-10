import { parseSyntaxId } from "~/syntax-game/validation";

type Dependencies = {
  checkAdminAuth(request: Request): Response | null;
  lookupHostKey(room: string): Promise<string | null>;
  defaultHostKey?: string;
  registryFetch(request: Request): Promise<Response>;
};

/** Explicit allowlist: never forward the internal snapshot or revision APIs. */
export async function routeSyntaxLibraryHttp(request: Request, deps: Dependencies): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/admin/syntax" || url.pathname.startsWith("/api/admin/syntax/")) {
    const error = deps.checkAdminAuth(request);
    if (error) return error;
    const path = url.pathname.slice("/api/admin".length);
    if (!/^\/syntax\/(entries|sets)(?:\/[^/]+)?$/.test(path)) return new Response("Not Found", { status: 404 });
    const response = await deps.registryFetch(new Request(`http://internal${path}`, request));
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  }
  const host = url.pathname.match(/^\/api\/rooms\/([^/]+)\/syntax\/sets$/);
  if (!host) return null;
  let room: string;
  try { room = parseSyntaxId(decodeURIComponent(host[1]), "Room"); }
  catch { return Response.json({ error: "Invalid room name." }, { status: 400 }); }
  const expected = await deps.lookupHostKey(room) ?? deps.defaultHostKey;
  if (!expected) return new Response("HOST_KEY not configured", { status: 500 });
  if ((request.headers.get("x-host-key") ?? url.searchParams.get("hostKey")) !== expected) return new Response("Unauthorized", { status: 401 });
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  const response = await deps.registryFetch(new Request("http://internal/syntax/launchable-sets"));
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
