import { createFileRoute } from "@tanstack/react-router";
import { SyntaxHistory } from "~/components/syntax-history";

export const Route = createFileRoute("/admin/history/$room/")({
  head: () => ({ meta: [{ title: "Game history | Syntax Live Polls" }] }),
  component: HistoryRoute,
});
function HistoryRoute() {
  const { room } = Route.useParams();
  return <SyntaxHistory key={room} room={room} />;
}
