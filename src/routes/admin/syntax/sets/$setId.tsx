import { createFileRoute } from "@tanstack/react-router";
import { SyntaxSetEditor } from "~/components/syntax-set-editor";

export const Route = createFileRoute("/admin/syntax/sets/$setId")({
  head: () => ({ meta: [{ title: "Game set editor | Spot the Syntax Error" }] }),
  component: SyntaxSetRoute,
});
function SyntaxSetRoute() {
  const { setId } = Route.useParams();
  return <SyntaxSetEditor key={setId} setId={setId} />;
}
