import { page } from "../../lib/fixtures.mjs";

export default {
  id: "responsive",
  routes: ["/responsive"],
  render() {
    return page({
      title: "Responsive Lab",
      body: `<section class="card"><h1>Responsive Lab</h1><p id="viewport-marker" class="marker">VIEWPORT-84</p><p id="viewport-value"></p></section>`,
      script: `
        const sample = () => {
          const data = { width: innerWidth, height: innerHeight, touchPoints: navigator.maxTouchPoints, userAgent: navigator.userAgent };
          document.querySelector("#viewport-value").textContent = data.width + "x" + data.height;
          browserEval.send("viewport.sample", data);
        };
        window.addEventListener("resize", sample);
        sample();
      `,
    });
  },
};
