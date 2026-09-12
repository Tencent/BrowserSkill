import { page } from "../../lib/fixtures.mjs";

export default {
  id: "hover-inspect",
  routes: ["/hover-inspect"],
  render() {
    return page({
      title: "Hover and Inspect",
      body: `<section class="card"><h1>Hover and Inspect</h1><div id="account-menu" tabindex="0"><button id="account-button" type="button">Account</button><div id="hover-panel"><button id="profile-link" type="button">Profile beta</button></div></div><p id="hover-result" class="marker" hidden>HOVER-17</p><article id="inspect-card" class="card" data-build="2026.08" data-marker="INSPECT-27"><h2>Inspection card</h2><p>Local HTML marker: <code>INSPECT-27</code></p></article></section>`,
      script: `
        const menu = document.querySelector("#account-menu");
        menu.addEventListener("mouseenter", () => { menu.classList.add("open"); browserEval.send("hover.menu_opened"); });
        document.querySelector("#profile-link").addEventListener("click", () => { document.querySelector("#hover-result").hidden = false; browserEval.send("hover.profile_clicked"); });
      `,
    });
  },
};
