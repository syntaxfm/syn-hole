import { createFileRoute } from "@tanstack/react-router";
import { SyntaxEntryEditor } from "~/components/syntax-entry-editor";

export const Route = createFileRoute("/admin/syntax/$entryId")({
  head: () => ({ meta: [{ title: "Screenshot editor | Spot the Syntax Error" }] }),
  component: SyntaxEntryRoute,
});
function SyntaxEntryRoute() {
  const { entryId } = Route.useParams();
  return <SyntaxEntryEditor key={entryId} entryId={entryId} />;
}
