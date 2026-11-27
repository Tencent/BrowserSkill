import { page, withRun } from "../../../lib/fixtures.mjs";

export default {
  id: "wheel-visibility-timeout",
  routes: ["/wheel-visibility-timeout", "/wheel-visibility-timeout/child"],
  render({ pathname, runId }) {
    const root = pathname === "/wheel-visibility-timeout";
    if (root) {
      return page({
        title: "OOPIF wheel visibility timeout regression",
        body: `
          <style>
            #frame-host { box-sizing: border-box; width: 500px; height: 340px; overflow: auto; border: 4px solid #333; }
            iframe { display: block; width: 460px; height: 620px; border: 0; }
          </style>
          <div id="frame-host"><iframe id="target-frame" title="cross-origin wheel target"></iframe></div>
        `,
        script: `
          const frame = document.querySelector("#target-frame");
          const child = new URL(${JSON.stringify(withRun("/wheel-visibility-timeout/child", runId))}, location.href);
          child.hostname = location.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
          frame.addEventListener("load", () => browserEval.send("fixture.root-ready", {}), { once: true });
          frame.src = child.href;
        `,
      });
    }

    return page({
      title: "Nested scroll target",
      body: `
        <style>
          #inner { box-sizing: border-box; position: relative; width: 260px; height: 110px; overflow: auto; border: 1px solid #444; }
          #content { position: relative; height: 900px; width: 240px; }
          #probe { position: absolute; top: 410px; left: 16px; width: 160px; height: 40px; }
        </style>
        <div id="inner"><div id="content"><button id="probe">wheel target</button></div></div>
      `,
      script: `
        window.wheels = [];
        document.addEventListener("wheel", (event) => {
          window.wheels.push({
            target: event.target.closest("#probe")?.id ?? "",
            deltaY: event.deltaY,
            trusted: event.isTrusted,
          });
        }, { capture: true });
        window.addEventListener("load", () => browserEval.send("fixture.child-ready", {}), { once: true });
      `,
    });
  },
};
