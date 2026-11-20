import { escapeHtml, page } from "../../../lib/fixtures.mjs";

const title = "Press reports the physical code for punctuation keys";
const marker = "CASE-PRESS_PUNCTUATION_KEY";

const script = `
(() => {
  const field = document.querySelector("#field");
  const result = document.querySelector("#result");
  const events = [];
  field.addEventListener("keydown", (event) => {
    events.push({
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
    });
  });
  document.querySelector("#check").addEventListener("click", () => {
    const slash = events.find((event) => event.key === "/");
    const ok = Boolean(
      slash &&
        slash.code === "Slash" &&
        slash.keyCode === 191 &&
        slash.ctrlKey === true &&
        slash.metaKey === false &&
        slash.altKey === false,
    );
    result.textContent = ok ? "PRESS-PUNCT-OK" : "PRESS-PUNCT-BAD";
    window.browserEval.send("press.checked", {
      count: events.length,
      key: slash?.key ?? "",
      code: slash?.code ?? "",
      keyCode: slash?.keyCode ?? 0,
      ctrlKey: slash?.ctrlKey ?? false,
      ok,
    });
  });
})();
`;

export default {
  id: "press-punctuation-key",
  routes: ["/cases/press-punctuation-key"],
  render() {
    return page({
      title,
      body: `<section class="card"><h1>${escapeHtml(title)}</h1><p class="marker">${marker}</p>
<label>Event field <input id="field" aria-label="Event field" autocomplete="off"></label>
<button id="check" type="button">Check key</button>
<p id="result" class="marker">PENDING</p>
<p class="muted">Pressing Ctrl+/ should reach the page as a physical Slash key, not an empty code.</p></section>`,
      script,
    });
  },
};
