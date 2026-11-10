import { useEffect, useState } from "react";
import { adminFetch, readAdminKey } from "~/utils/admin-api";
import type { SyntaxHistoryPage } from "~/syntax-game/history";
import { syntaxHistoryStandings } from "~/syntax-game/history";
import { groupSyntaxRoundStandings } from "~/syntax-game/scoring";
import type { SyntaxSession } from "~/syntax-game/types";
import { SyntaxStandings, syntaxElapsedLabel } from "./syntax-standings";
import { SyntaxImageSurface } from "./syntax-image-surface";

const historyPath = (room: string) => `/admin/history/${encodeURIComponent(room)}`;
const timestamp = (value: number) => new Date(value).toLocaleString();
const status = (phase: SyntaxSession["phase"]) => phase === "finished" ? "Completed" : phase === "aborted" ? "Aborted" : `Active · ${phase}`;

export function SyntaxHistory({ room, gameId }: { room: string; gameId?: string }) {
  const [key, setKey] = useState<string | null>(null);
  const [page, setPage] = useState<SyntaxHistoryPage | null>(null);
  const [session, setSession] = useState<SyntaxSession | null>(null);
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setKey(readAdminKey()), []);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    setLoading(true); setError(null); setSession(null); setPage(null);
    const endpoint = `/api/admin/rooms/${encodeURIComponent(room)}/syntax/history${gameId ? `/${encodeURIComponent(gameId)}` : `?offset=${offset}`}`;
    adminFetch(endpoint, key, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(response.status === 401 ? "Unauthorized. Log in to Room Admin again." : response.status === 404 ? "Game not found." : "Could not load history.");
      if (gameId) {
        const data = await response.json() as { session: SyntaxSession };
        if (!controller.signal.aborted) setSession(data.session);
      } else {
        const data = await response.json() as SyntaxHistoryPage;
        if (!controller.signal.aborted) setPage(data);
      }
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [key, room, gameId, offset, reload]);
  return <main className="app admin-app syntax-history">
    <header className="admin-header"><div><h1>{gameId ? "Game review" : "Syntax game history"}</h1><p className="muted"><a href="/admin/">Room Admin</a> · <a href={historyPath(room)}>{room} history</a></p></div><button className="admin-action-btn" disabled={!key || loading} onClick={() => setReload(n => n + 1)}>Refresh</button></header>
    {key === "" && <p className="error"><a href="/admin/">Log in to Room Admin</a> first.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {loading && <p role="status">Loading history…</p>}
    {page && <section className="panel">
      {!page.games.length && <p>No saved games on this page.</p>}
      {page.games.map(game => <article key={game.id} className="admin-question-row"><div><h2><a href={`${historyPath(room)}/${encodeURIComponent(game.id)}`}>{game.title}</a></h2><p>{status(game.phase)} · {timestamp(game.preparedAt)} · {game.submissionMode}</p><p className="muted">{game.revealedRounds}/{game.rounds} rounds revealed · {game.participants} players</p></div></article>)}
      <div className="button-row"><button className="admin-action-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</button><button className="admin-action-btn" disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset!)}>Next</button></div>
    </section>}
    {session && <SyntaxHistoryDetail session={session} />}
  </main>;
}

function SyntaxHistoryDetail({ session }: { session: SyntaxSession }) {
  const [roundIndex, setRoundIndex] = useState(0);
  const round = session.snapshot.rounds[roundIndex];
  const revealed = session.revealedRoundIndexes.includes(roundIndex);
  const answers = session.answers.filter(answer => answer.roundIndex === roundIndex);
  // Older stored answers may lack elapsed time. Never use an epoch timestamp as
  // an invented duration when the old round's opening time was not retained.
  const roundStandings = revealed && answers.every(answer => answer.elapsedMs !== undefined)
    ? groupSyntaxRoundStandings(session.players, answers, roundIndex, 0, session.snapshot.askPlayMode) : [];
  return <>
    <section className="panel"><h2>{session.snapshot.title}</h2><p>{status(session.phase)} · {session.snapshot.submissionMode} · {session.snapshot.askPlayMode ? "In-person / online groups" : "Everyone together"}</p><p>Prepared {timestamp(session.snapshot.preparedAt)}</p>
      {session.timing && <p>Last started round: {timestamp(session.timing.openedAt)} · Deadline: {timestamp(session.timing.deadlineAt)}</p>}
      <span className="syntax-status">{session.revealedRoundIndexes.length} rounds revealed</span>
      <SyntaxStandings standings={syntaxHistoryStandings(session)} final={session.phase === "finished"} />
    </section>
    <section className="panel"><label className="admin-field-label">Review round<select className="text-input" value={roundIndex} onChange={event => setRoundIndex(Number(event.target.value))}>{session.snapshot.rounds.map((round, index) => <option key={index} value={index}>{index + 1}. {round.entry.title} · {round.durationMs / 1000}s · {session.revealedRoundIndexes.includes(index) ? "Revealed" : "Not revealed"}</option>)}</select></label>
      <h2>Round {roundIndex + 1}: {round.entry.title}</h2><p className="muted">{round.durationMs / 1000}s · {revealed ? "Revealed" : "Private · not revealed"}</p>
      <SyntaxImageSurface key={`${session.snapshot.id}:${roundIndex}`} mode="reveal" image={round.entry.image} targets={round.entry.targets} revealedPoints={answers.map(answer => ({ x: answer.point.x, y: answer.point.y }))} />
      <p>{round.entry.explanation}</p>
      {revealed && <><h3>Cumulative through round {roundIndex + 1}</h3><SyntaxStandings standings={syntaxHistoryStandings(session, roundIndex)} /><h3>Round-only points</h3><SyntaxStandings standings={syntaxHistoryStandings({ ...session, revealedRoundIndexes: [roundIndex] })} roundStandings={roundStandings} /></>}
      <details className="syntax-details"><summary>{revealed ? "Player results" : "Private answers · excluded from standings"}</summary>
        <div className="syntax-history-table"><table><thead><tr><th>Player</th><th>Group</th><th>Result</th><th>Elapsed</th><th>{revealed ? "Points" : "Raw points"}</th></tr></thead><tbody>{session.players.map(player => {
          const answer = answers.find(answer => answer.playerId === player.id);
          return <tr key={player.id}><td>{player.name}</td><td>{player.playMode ?? "Unassigned"}</td><td>{answer ? answer.correct ? "Correct" : "Incorrect" : "No answer"}</td><td>{answer?.elapsedMs === undefined ? "—" : syntaxElapsedLabel(answer.elapsedMs)}</td><td>{answer?.points ?? (revealed ? 0 : "—")}</td></tr>;
        })}</tbody></table></div>
      </details>
    </section>
  </>;
}
