import { createFileRoute } from "@tanstack/react-router";
import { RoomQuestionsEditor } from "~/components/room-questions";

export const Route = createFileRoute("/admin/$room")({
  head: ({ params }) => ({
    meta: [{ title: `${params.room} Questions | Syntax Live Polls` }],
  }),
  component: RoomQuestionsRoute,
});

function RoomQuestionsRoute() {
  const { room } = Route.useParams();
  return <RoomQuestionsEditor key={room} room={room} />;
}
