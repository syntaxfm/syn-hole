import { registerHooks } from "node:module";

// Node 24 strips TypeScript natively; mirror Vite's ~/ alias without a dependency.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("~/")) {
      return nextResolve(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});
