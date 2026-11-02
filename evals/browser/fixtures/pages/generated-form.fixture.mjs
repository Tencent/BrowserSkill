import { escapeHtml, page } from "../../lib/fixtures.mjs";
import { describeSeed } from "../../lib/seeded-generator.mjs";

function nest(content, depth) {
  let nested = content;
  for (let index = 0; index < depth; index += 1) {
    nested = `<div data-depth="${index + 1}">${nested}</div>`;
  }
  return nested;
}

function textField(dimensions) {
  const id = `matrix-text-${dimensions.idSuffix}`;
  const input = `<input id="${id}" name="text" autocomplete="off">`;
  if (dimensions.labelMode === "wrapped") return `<label>Text input${input}</label>`;
  if (dimensions.labelMode === "for") return `<label for="${id}">Text input</label>${input}`;
  return `<span id="${id}-label">Text input</span><input id="${id}" name="text" aria-labelledby="${id}-label" autocomplete="off">`;
}

function formMarkup(dimensions, runId) {
  const text = textField(dimensions);
  const select = `<label>Dropdown<select name="choice"><option value="one">One</option><option value="two">Two</option><option value="three">Three</option></select></label>`;
  const fields = dimensions.fieldOrder === "text-first" ? `${text}${select}` : `${select}${text}`;
  const decoy =
    dimensions.decoy === "disabled-input"
      ? `<label>Text input<input disabled value="decoy"></label>`
      : dimensions.decoy === "duplicate-text"
        ? `<p class="muted">Text input is intentionally repeated in helper copy.</p>`
        : "";
  return nest(
    `<form action="/matrix/generated-result" method="get"><input type="hidden" name="run" value="${escapeHtml(runId)}"><input type="hidden" name="seed" value="${dimensions.seed}">${decoy}${fields}<button type="submit">Submit matrix form</button></form>`,
    dimensions.nestingDepth,
  );
}

export default {
  id: "generated-form",
  routes: ["/matrix/generated-form", "/matrix/generated-result"],
  render({ pathname, runId, query, record }) {
    const dimensions = describeSeed(query.get("seed") ?? 1);
    if (pathname === "/matrix/generated-form") {
      const markup = JSON.stringify(formMarkup(dimensions, runId));
      const dimensionsJson = JSON.stringify(dimensions);
      return page({
        title: "Seeded Matrix Form",
        body: `<section class="card"><h1>Seeded Matrix Form</h1><p class="marker">SEED-${dimensions.seed}</p><div id="matrix-root">Hydrating…</div></section>`,
        script: `
          const hydrate = () => {
            const root = document.querySelector("#matrix-root");
            root.innerHTML = ${markup};
            root.querySelector("button[type=submit]").addEventListener("keydown", (event) => {
              if (event.key === "Enter") browserEval.send("matrix.enter_pressed");
            });
            browserEval.send("matrix.ready", ${dimensionsJson});
          };
          setTimeout(hydrate, ${dimensions.hydrationDelayMs});
        `,
      });
    }
    const values = {
      seed: dimensions.seed,
      text: query.get("text") ?? "",
      choice: query.get("choice") ?? "",
    };
    record("matrix.submitted", values, { path: pathname });
    return page({
      title: "Matrix Result",
      body: `<section class="card"><h1>Matrix Result</h1><p class="marker">MATRIX-OK</p><p>${escapeHtml(values.text)} | ${escapeHtml(values.choice)} | seed ${values.seed}</p></section>`,
    });
  },
};
