import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The daemon tests spawn real child processes and adjust the process
    // working directory so a fake `bsk` can answer like the real CLI; the
    // worker-threads pool does not support `process.chdir`.
    pool: "forks",
  },
});
