import { escapeHtml, page } from "../../lib/fixtures.mjs";

export default {
  id: "form",
  routes: ["/form", "/result"],
  render({ pathname, runId, query, record }) {
    if (pathname === "/form") {
      return page({
        title: "Browser Eval Form",
        body: `<section class="card"><h1>Web form</h1><form action="/result" method="get"><input type="hidden" name="run" value="${escapeHtml(runId)}"><label>Text input<input id="text-input" name="text" autocomplete="off"></label><label>Textarea<textarea id="notes" name="notes"></textarea></label><label>Dropdown<select id="choice" name="choice"><option value="one">One</option><option value="two">Two</option><option value="three">Three</option></select></label><button id="submit" type="submit">Submit</button></form></section>`,
        script: `document.querySelector("#submit").addEventListener("keydown", (event) => { if (event.key === "Enter") browserEval.send("form.enter_pressed"); });`,
      });
    }
    const values = {
      text: query.get("text") ?? "",
      notes: query.get("notes") ?? "",
      choice: query.get("choice") ?? "",
    };
    record("form.submitted", values, { path: pathname });
    return page({
      title: "Form Result",
      body: `<section class="card"><h1>Received!</h1><p id="submitted-values" class="marker">${escapeHtml(values.text)} | ${escapeHtml(values.notes)} | ${escapeHtml(values.choice)}</p></section>`,
    });
  },
};
