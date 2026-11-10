import type { SyntaxGroupStandings, SyntaxRoundGroupStandings, SyntaxRoundStanding, SyntaxStanding } from "~/syntax-game/types";

export type SyntaxStandingsProps = {
  standings: readonly SyntaxGroupStandings[];
  roundStandings?: readonly SyntaxRoundGroupStandings[];
  yourStanding?: SyntaxStanding | null;
  yourRoundStanding?: SyntaxRoundStanding | null;
  final?: boolean;
};

function groupLabel(mode: SyntaxStanding["playMode"]) {
  return mode === "in-person" ? "In person" : mode === "online" ? "Online" : "Everyone";
}

export function syntaxElapsedLabel(elapsedMs: number): string {
  return `${(elapsedMs / 1000).toFixed(3)}s`;
}

/** Shared read-only presentation. Ranks are server ranks, never array indexes. */
export function SyntaxStandings({ standings, roundStandings = [], yourStanding = null, yourRoundStanding = null, final = false }: SyntaxStandingsProps) {
  const splitRounds = roundStandings.length > 1;
  const splitOverall = standings.length > 1;
  return <div className="syntax-standings syntax-standings-grid">
    {roundStandings.length > 0 && <section className="syntax-standings-section" aria-label="Fastest correct this round">
      <h3>Fastest correct</h3>
      {roundStandings.map((group) => <section key={group.playMode ?? "everyone"} aria-label={groupLabel(group.playMode)}>
        {splitRounds && <h4>{groupLabel(group.playMode)}</h4>}
        {group.standings.length === 0 ? <div className="muted">No correct answers</div> : <table className="syntax-standings-table">
          <thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Time</th></tr></thead>
          <tbody>{group.standings.map((row) => <tr key={row.playerId} data-you={row.playerId === yourRoundStanding?.playerId}><td>#{row.rank}</td><th scope="row">{row.name}{row.playerId === yourRoundStanding?.playerId ? " (you)" : ""}</th><td>{syntaxElapsedLabel(row.elapsedMs)}</td></tr>)}
            {yourRoundStanding?.playMode === group.playMode && !group.standings.some((row) => row.playerId === yourRoundStanding.playerId) && <tr data-you="true"><td>#{yourRoundStanding.rank}</td><th scope="row">You</th><td>{syntaxElapsedLabel(yourRoundStanding.elapsedMs)}</td></tr>}
          </tbody>
        </table>}
        {group.total > group.standings.length && <small className="muted">Top {group.standings.length} of {group.total}</small>}
      </section>)}
    </section>}
    <section className="syntax-standings-section" aria-label={final ? "Final standings" : "Cumulative standings"}>
      <h3>{final ? "Final standings" : "Overall"}</h3>
      {!standings.length && <div className="muted">No results yet</div>}
      {standings.map((group) => <section key={group.playMode ?? "everyone"} aria-label={groupLabel(group.playMode)}>
        {splitOverall && <h4>{groupLabel(group.playMode)}</h4>}
        {!group.standings.length ? <div className="muted">No players yet</div> : <table className="syntax-standings-table">
          <thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Points</th><th scope="col">Correct</th></tr></thead>
          <tbody>{group.standings.map((row) => <tr key={row.playerId} data-you={row.playerId === yourStanding?.playerId}><td>#{row.rank}</td><th scope="row">{row.name}{row.playerId === yourStanding?.playerId ? " (you)" : ""}</th><td>{row.points}</td><td>{row.correct}</td></tr>)}
            {yourStanding?.playMode === group.playMode && !group.standings.some((row) => row.playerId === yourStanding.playerId) && <tr data-you="true"><td>#{yourStanding.rank}</td><th scope="row">You</th><td>{yourStanding.points}</td><td>{yourStanding.correct}</td></tr>}
          </tbody>
        </table>}
        {group.total > group.standings.length && <small className="muted">Top {group.standings.length} of {group.total}</small>}
      </section>)}
    </section>
  </div>;
}
