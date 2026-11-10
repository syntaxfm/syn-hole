import { createFileRoute } from "@tanstack/react-router";
import { SyntaxLibrary } from "~/components/syntax-library";

export const Route = createFileRoute("/admin/syntax/")({
  head: () => ({ meta: [{ title: "Spot the Syntax Error | Syntax Live Polls" }] }),
  component: SyntaxLibrary,
});
