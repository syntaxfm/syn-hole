## Realtime Conference Polling

Cloudflare Workers + PartyServer sample for live conference polling with three views:

- `Audience`: answer the active multiple choice question
- `Host`: control question flow, voting, and reveal
- `Projector`: display live aggregated results

Each room has its own questions, edited at `/admin/<room>` (Room Admin › Questions). `src/data/questions.ts` is the starter list a room begins with. Correct answers remain server-only until reveal.

