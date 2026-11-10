import { createFileRoute } from "@tanstack/react-router";
import { SyntaxSetEditor } from "~/components/syntax-set-editor";

export const Route = createFileRoute("/admin/syntax/sets/new")({
  head: () => ({ meta: [{ title: "New game set | Spot the Syntax Error" }] }),
  component: () => <SyntaxSetEditor />,
});
