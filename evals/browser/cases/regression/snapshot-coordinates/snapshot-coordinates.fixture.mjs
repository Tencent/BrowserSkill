import { page, withRun } from "../../../lib/fixtures.mjs";

export default {
  id: "snapshot-coordinates",
  routes: ["/snapshot-coordinates", "/snapshot-coordinates/frame", "/snapshot-coordinates/nested"],
  render({ pathname, runId, query }) {
    const root = pathname === "/snapshot-coordinates";
    const nested = pathname.endsWith("/nested");
    return page({
      title: "Snapshot coordinate regression",
      body: `
        <style>
          main { margin: 0; width: auto; }
          body { width: 2000px; height: 2400px; }
          html { overflow-anchor: none; }
          ${query.get("scrollbars") === "none" ? "html { scrollbar-width: none; }" : ""}
          button { position: absolute; box-sizing: border-box; padding: 0; border: 2px solid black; border-radius: 0; }
          #probe { left: ${root ? 180 : 100}px; top: ${root ? 360 : 160}px; width: 120px; height: 40px; }
          iframe { position: absolute; box-sizing: content-box; width: 320px; height: 220px;
            border: 6px solid black; padding: 8px; transform: scale(1.25); transform-origin: 0 0; }
          #same { left: 340px; top: 400px; }
          #cross { left: 820px; top: 400px; }
          #nested { left: 150px; top: 210px; width: 130px; height: 70px; border-width: 2px; padding: 4px; transform: scale(0.8); }
          ${nested ? "#probe { left: 30px; top: 40px; width: 60px; height: 20px; }" : ""}
        </style>
        <button id="probe" data-geometry-probe>GEOMETRY-195</button>
        ${root ? `<iframe id="same" name="same" title="same-process frame" src="${withRun("/snapshot-coordinates/frame", runId)}"></iframe><iframe id="cross" name="cross" title="cross-site frame"></iframe>` : ""}
        ${!root && !nested ? `<iframe id="nested" name="nested" title="nested frame" src="${withRun("/snapshot-coordinates/nested", runId)}"></iframe>` : ""}
      `,
      script: `
        history.scrollRestoration = "manual";
        const cross = document.querySelector("#cross");
        if (cross) {
          const url = new URL(${JSON.stringify(withRun("/snapshot-coordinates/frame", runId))}, location.href);
          url.hostname = location.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
          // Isolate unit conversion from the pre-existing OOPIF scrollbar-width
          // projection issue. ?classic-scrollbars retains that separate reproduction.
          if (!new URLSearchParams(location.search).has("classic-scrollbars")) url.searchParams.set("scrollbars", "none");
          cross.src = url.href;
        }
        window.addEventListener("load", () => {
          scrollTo(${root ? "80, 240" : nested ? "10, 20" : "40, 100"});
          requestAnimationFrame(() => requestAnimationFrame(() => {
            window.geometryReady = true;
            document.documentElement.dataset.geometryReady = "true";
            browserEval.send("geometry.ready", { root: ${root} });
          }));
        });
      `,
    });
  },
};
