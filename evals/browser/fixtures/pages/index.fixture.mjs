import { page } from "../../lib/fixtures.mjs";

export default {
  id: "fixture-index",
  routes: ["/"],
  render() {
    return page({
      title: "Browser Eval Fixtures",
      body: `<section class="card"><h1>Browser Eval Fixtures</h1><p class="muted">Deterministic local pages for agent-neutral browser evaluation.</p></section>`,
    });
  },
};
