import { createFileRoute } from "@tanstack/react-router";
import { SyntaxHistory } from "~/components/syntax-history";

export const Route = createFileRoute("/admin/history/$room/$gameId")({
  head: () => ({ meta: [{ title: "Game review | Syntax Live Polls" }] }),
  component: HistoryRoute,
});
function HistoryRoute() {
  const { room, gameId } = Route.useParams();
  return <SyntaxHistory key={`${room}:${gameId}`} room={room} gameId={gameId} />;
}
