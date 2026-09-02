import { escapeHtml, page, withRun } from "../../lib/fixtures.mjs";

export default {
  id: "tabs",
  routes: ["/tabs", "/tabs/child"],
  render({ pathname, runId }) {
    if (pathname === "/tabs") {
      return page({
        title: "Tab Lab",
        body: `<section class="card"><h1>Tab Lab</h1><p>Keep this original tab open while visiting the child page in a new tab.</p><p class="muted">Child URL: <code>${escapeHtml(withRun("/tabs/child", runId))}</code></p></section>`,
      });
    }
    return page({
      title: "Child Tab",
      body: `<section class="card"><h1>Child Tab</h1><p id="tab-token" class="marker">TAB-29</p><button id="mark-child" type="button">Mark child visited</button><p id="child-status" hidden>Marked</p></section>`,
      script: `document.querySelector("#mark-child").addEventListener("click", () => { document.querySelector("#child-status").hidden = false; browserEval.send("tabs.child_marked"); });`,
    });
  },
};
