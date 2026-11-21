import { escapeHtml, page } from "../../../lib/fixtures.mjs";

const title = "Fill notifies each final value once";
const marker = "CASE-FILL_INPUT_EVENTS";

const script = `
(() => {
  const field = document.querySelector("#field");
  const result = document.querySelector("#result");
  const inputValues = [];
  const changeValues = [];
  field.addEventListener("input", () => {
    inputValues.push(field.value);
  });
  field.addEventListener("change", () => {
    changeValues.push(field.value);
  });
  document.querySelector("#check").addEventListener("click", () => {
    const ok =
      inputValues.length === 1 &&
      inputValues[0] === "Hello" &&
      changeValues.includes("Hello") &&
      field.value === "Hello";
    result.textContent = ok ? "FILL-EVENTS-OK" : "FILL-EVENTS-BAD";
    window.browserEval.send("fill.checked", {
      inputCount: inputValues.length,
      inputValues: inputValues.join("|"),
      changeValues: changeValues.join("|"),
      finalValue: field.value,
      ok,
    });
  });
})();
`;

export default {
  id: "fill-input-events",
  routes: ["/cases/fill-input-events"],
  render() {
    return page({
      title,
      body: `<section class="card"><h1>${escapeHtml(title)}</h1><p class="marker">${marker}</p>
<label>Event field <input id="field" aria-label="Event field" autocomplete="off"></label>
<button id="check" type="button">Check events</button>
<p id="result" class="marker">PENDING</p>
<p class="muted">Filling without clearing should notify the page once for the final value.</p></section>`,
      script,
    });
  },
};
