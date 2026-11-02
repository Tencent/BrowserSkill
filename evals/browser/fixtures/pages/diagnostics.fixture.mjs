import { page } from "../../lib/fixtures.mjs";

export default {
  id: "diagnostics",
  routes: ["/diagnostics"],
  render() {
    return page({
      title: "Diagnostics Lab",
      body: `<section class="card"><h1>Diagnostics Lab</h1><p>Inspect console and network buffers.</p><p id="network-status" class="muted">Ping pending</p></section>`,
      script: `
        console.log("Browser eval console marker: CONSOLE-61");
        fetch("/api/ping?run=" + encodeURIComponent(browserEval.runId))
          .then((response) => response.json())
          .then(({ token }) => { document.querySelector("#network-status").textContent = "Ping completed: " + token; });
      `,
    });
  },
};
