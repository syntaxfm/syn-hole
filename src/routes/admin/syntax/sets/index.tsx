import { createFileRoute } from "@tanstack/react-router";
import { SyntaxSetList } from "~/components/syntax-set-list";

export const Route = createFileRoute("/admin/syntax/sets/")({
  head: () => ({ meta: [{ title: "Game sets | Spot the Syntax Error" }] }),
  component: SyntaxSetList,
});
