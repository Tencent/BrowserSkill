import { page, withRun } from "../../lib/fixtures.mjs";

export default {
  id: "navigation",
  routes: ["/navigation/start", "/navigation/detail"],
  render({ pathname, runId }) {
    if (pathname === "/navigation/start") {
      return page({
        title: "Navigation Start",
        body: `<section class="card"><h1>Navigation Start</h1><p>Use the link to open the deterministic detail page.</p><a id="details-link" class="button" href="${withRun("/navigation/detail", runId)}">Details</a></section>`,
        script: `document.querySelector("#details-link").addEventListener("click", () => browserEval.send("navigation.detail.clicked"));`,
      });
    }
    return page({
      title: "Navigation Detail",
      body: `<section class="card"><h1>Navigation Detail</h1><p>Stable detail code:</p><p id="navigation-code" class="marker">NAV-42</p></section>`,
    });
  },
};
