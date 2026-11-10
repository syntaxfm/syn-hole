## Realtime Conference Polling

Cloudflare Workers + PartyServer sample for live conference polling with three views:

- `Audience`: answer the active multiple choice question
- `Host`: control question flow, voting, and reveal
- `Projector`: display live aggregated results

Each room has its own questions, edited at `/admin/<room>` (Room Admin › Questions). `src/data/questions.ts` is the starter list a room begins with. Correct answers remain server-only until reveal.

## Local development

Use Node 24 and pnpm (the version is pinned in `package.json`). Install with
`pnpm install`, then create a gitignored `.dev.vars`:

```dotenv
HOST_KEY=change-me
ADMIN_KEY=change-me-admin
```

`HOST_KEY` is the fallback for rooms without their own host key. These values are
not defaults in `wrangler.jsonc`; use strong separate secrets in production.

Run `pnpm dev` and open:

- Audience: http://localhost:5173/r/main-stage/
- Host: http://localhost:5173/r/main-stage/host?hostKey=change-me
- Projector: http://localhost:5173/r/main-stage/screen
- Admin: http://localhost:5173/admin/?adminKey=change-me-admin

Cloudflare's local runtime supplies SQLite Durable Objects and R2 image storage;
no external database or Cloudflare login is required locally. Local data lives
under `.wrangler/`. Vite ignores `.pnpm-store/` because pnpm's project links can
otherwise send its watcher through a recursive directory cycle.

## Spot the Syntax Error

This is a separate room mode; switching to a game preserves the room's polls.

1. Open **Spot the Syntax Error** from Admin (`/admin/syntax/`). Create a draft,
   upload a screenshot, click to place targets and adjust their size on the canvas.
   Test clicks, then enable **Use in games**.
2. Open **Game sets** (`/admin/syntax/sets/`). Save a named, ordered selection of
   screenshots with a default duration and optional per-round overrides.
3. In the room's host view, choose a set and submission style: **first click
   locks** or **select, then confirm**. **Prepare game** preloads the screenshot
   without displaying it to players. **Start round** displays it and starts the
   server-controlled timer.
4. When time expires, answers close automatically. **Reveal answers** shows the
   targets, personal results, fastest-correct players and cumulative standings.
   The projector also shows anonymous clicks, including misses.
5. **Prepare next round** does not start its timer. After the final reveal,
   **Finish game** retains results. Returning to polls requires finishing or
   explicitly aborting the game; aborting does not reveal unfinished answers.

Admins can open **Game history** on a room's admin card, or visit
`/admin/history/<room>/`, to inspect retained games, round screenshots, accepted
targets and stored results. History is read-only and admin-authenticated. Removing
a room's registry entry or resetting its polls does not erase game history.

Images support zoom/pan on phones. Targets use normalized coordinates and
aspect-correct circles; radius is a fraction of original image width. Any target
counts. Supported uploads are still PNG/JPEG/GIF/WebP, at most 10 MiB and
16 megapixels. Replacing an image resets its targets and review status. Immutable
image revisions and session snapshots are retained, including after library edits.

### Timing, scores and identity

- A correct answer earns `round(1000 × remaining time / round duration)` points;
  misses and missing answers earn zero. Proximity determines correctness only.
- The server measures receipt time; answers received at or after the deadline
  are late. Network latency contributes to measured speed. Client timers are
  advisory and loading/reconnecting never restarts a round.
- Each browser identity gets one accepted answer per round. Reconnects restore
  its receipt; an identical retry is safe. Display names are not unique identities.
  Browser IDs are not authentication or protection against deliberate impersonation.
- Games admit at most 1,000 players, including disconnected identities, and
  immutable launch snapshots are limited to 1 MiB. At capacity, existing players
  can reconnect and keep answering; additional identities must wait for a new game.
  Players and answers are stored in separate rows so long games cannot overflow
  a single Durable Object SQL value. Existing local history remains readable.
- Late joiners can answer the current round while time remains; prior rounds
  score zero. The room's in-person/online setting is captured at game launch.
- Equal scores share competition ranks. Fastest-correct round results use server
  elapsed time. Public standings show the top 20 per group plus your own rank.
- Answers, correctness and current-round scores stay private until manual reveal.
  Preloading hides an image visually; it is not anti-cheat asset secrecy.


## Verification

```sh
pnpm test
pnpm exec tsc --noEmit
pnpm build
```

Tests use Node 24's built-in test runner and TypeScript stripping. Builds do not
deploy; deployment remains an explicit separate operation.
