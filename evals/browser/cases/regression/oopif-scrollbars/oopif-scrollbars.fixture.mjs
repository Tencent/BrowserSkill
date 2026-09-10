import { page, withRun } from "../../../lib/fixtures.mjs";

export default {
  id: "oopif-scrollbars",
  routes: ["/oopif-scrollbars", "/oopif-scrollbars/frame", "/oopif-scrollbars/nested"],
  render({ pathname, runId, query }) {
    const root = pathname === "/oopif-scrollbars";
    const nested = pathname.endsWith("/nested");
    const mode = query.get("scrollbars") ?? "both";
    return page({
      title: "OOPIF scrollbar geometry regression",
      body: `
        <style>
          main { margin: 0; width: auto; }
          body { width: 2000px; height: 2400px; }
          html { overflow-anchor: none; }
          ${!root ? `html { overflow-x: ${mode === "vertical" || mode === "none" ? "hidden" : "scroll"}; overflow-y: ${mode === "horizontal" || mode === "none" ? "hidden" : "scroll"}; } html::-webkit-scrollbar { width: 17px; height: 11px; }` : ""}
          button { position: absolute; padding: 0; border: 0; border-radius: 0; }
          #probe { left: ${root ? 180 : nested ? 30 : 100}px; top: ${root ? 360 : nested ? 40 : 160}px; width: 60px; height: 20px; }
          #edge { position: fixed; right: -20px; bottom: -15px; width: 80px; height: 60px; }
          #outside { position: fixed; left: calc(100% + 2px); top: calc(100% + 2px); width: 10px; height: 10px; }
          iframe { position: absolute; box-sizing: content-box; width: 420px; height: 320px;
            left: 340px; top: 400px; border: 6px solid black; padding: 8px; transform: scale(1.2); transform-origin: 0 0; }
          #nested { left: 150px; top: 210px; width: 200px; height: 120px; border-width: 4px; padding: 6px; transform: scale(0.8); }
        </style>
        <button id="probe" data-geometry-probe>OOPIF-SCROLLBARS</button>
        ${!root ? '<button id="edge" data-geometry-probe>EDGE</button><button id="outside" data-geometry-probe>OUTSIDE</button>' : ""}
        ${!nested ? `<iframe id="${root ? "cross" : "nested"}" name="${root ? "cross" : "nested"}" title="${root ? "outer" : "nested"} cross-site frame"></iframe>` : ""}
      `,
      script: `
        history.scrollRestoration = "manual";
        const child = document.querySelector("iframe");
        if (child) {
          const url = new URL(${JSON.stringify(withRun(root ? "/oopif-scrollbars/frame" : "/oopif-scrollbars/nested", runId, { scrollbars: mode }))}, location.href);
          url.hostname = location.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
          child.src = url.href;
        }
        document.addEventListener("click", event => {
          const probe = event.target.closest("[data-geometry-probe]");
          if (probe) browserEval.send("geometry.clicked", { probe: probe.id });
        });
        window.addEventListener("load", () => {
          scrollTo(${root ? "80, 240" : nested ? "10, 20" : "40, 100"});
          requestAnimationFrame(() => requestAnimationFrame(() => {
            document.documentElement.dataset.geometryReady = "true";
            if (!${root}) browserEval.send("geometry.scrollbars", {
              vertical: innerWidth > document.documentElement.clientWidth,
              horizontal: innerHeight > document.documentElement.clientHeight,
            });
            browserEval.send("geometry.ready", { root: ${root} });
          }));
        });
      `,
    });
  },
};
