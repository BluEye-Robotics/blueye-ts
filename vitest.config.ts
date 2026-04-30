import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      // jszmq ships bundler-style ESM (no .js on relative imports), so route it
      // through Vite's resolver instead of Node's strict ESM resolver.
      deps: {
        inline: [/@blueyerobotics\/jszmq/],
      },
    },
  },
});
