// @vitest-environment node
// Explicit opt-in against a matching, reloaded extension:
// BSK_LIVE_NAVIGATION_CLI=/absolute/path/to/bsk vitest run restricted-navigation.live
// Creates and stops its own unfocused session; does not borrow existing tabs.
// Uses real chrome.debugger permissions, not an unrestricted remote-CDP adapter.
import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe.skipIf(!process.env.BSK_LIVE_NAVIGATION_CLI)(
  "restricted background navigation (live extension)",
  () => {
    it("follows background navigation and redirects to rAF-dependent readiness without selecting tabs", async () => {
      const waiting = new Map<string, ServerResponse>();
      const ready = new Set<string>();
      const requests = new Set<string>();
      const pixel = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      );
      const finishImage = (response: ServerResponse) => {
        response.setHeader("Content-Type", "image/gif");
        response.end(pixel);
      };
      const server = createServer((req, res) => {
        const url = new URL(req.url!, "http://fixture.test");
        const key = url.searchParams.get("case") ?? "";
        if (url.pathname === "/gate") {
          if (ready.has(key)) finishImage(res);
          else waiting.set(key, res);
        } else if (url.pathname === "/ready") {
          ready.add(key);
          const image = waiting.get(key);
          if (image) {
            waiting.delete(key);
            finishImage(image);
          }
          res.end("ok");
        } else if (url.pathname === "/source") {
          res.end("<!doctype html><h1>Source</h1>");
        } else if (url.pathname === "/page" && url.searchParams.get("mode") === "server") {
          requests.add(key);
          res.writeHead(302, { Location: `/final?case=${key}` });
          res.end();
        } else if (
          (url.pathname === "/page" &&
            ["sync", "dcl", "chain"].includes(url.searchParams.get("mode") ?? "")) ||
          url.pathname === "/hop"
        ) {
          requests.add(key);
          const mode = url.searchParams.get("mode");
          const next = mode === "chain" ? `/hop?case=${key}` : `/final?case=${key}`;
          const redirect = `location.replace(${JSON.stringify(next)})`;
          res.setHeader("Content-Type", "text/html");
          res.end(
            `<!doctype html><script>${mode === "dcl" ? `document.addEventListener('DOMContentLoaded',()=>{${redirect}})` : redirect}</script><h1>Redirecting</h1>`,
          );
        } else {
          requests.add(key);
          res.setHeader("Content-Type", "text/html");
          res.end(`<!doctype html><title>Restricted navigation regression</title>
          <h1 id="status">Waiting for animation frame</h1><img src="/gate?case=${key}">
          <script>requestAnimationFrame(()=>requestAnimationFrame(()=>{
          document.querySelector('#status').textContent='Background ready';
          fetch('/ready?case=${key}').then(response=>response.text());}));</script>`);
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/page`;
      const run = async <T>(args: string[]): Promise<T> => {
        try {
          const { stdout } = await exec(process.env.BSK_LIVE_NAVIGATION_CLI!, [...args, "--json"], {
            timeout: 45_000,
            maxBuffer: 1024 * 1024,
          });
          return JSON.parse(stdout) as T;
        } catch (error) {
          const failure = error as Error & { stdout?: string; stderr?: string };
          throw new Error(
            `${args[0]} failed (server requests: ${[...requests].join(", ")}): ${failure.stdout ?? failure.message} ${failure.stderr ?? ""}`,
          );
        }
      };
      let session: string | undefined;
      try {
        session = (
          await run<{ session_id: string }>([
            "session",
            "start",
            "--no-focus",
            ...(process.env.BSK_LIVE_NAVIGATION_BROWSER
              ? ["--browser", process.env.BSK_LIVE_NAVIGATION_BROWSER]
              : []),
            "--name",
            "restricted-navigation-regression",
          ])
        ).session_id;
        for (const source of ["restricted", "http"]) {
          for (const mode of ["direct", "server", "sync", "dcl", "chain"]) {
            const phases =
              mode === "direct" || mode === "server"
                ? ["load", "networkidle", "commit", "domcontentloaded"]
                : ["load", "networkidle"];
            for (const phase of phases) {
              const key = `${source}-${mode}-${phase}`;
              const destination = `${url}?case=${key}&mode=${mode}`;
              const finalUrl =
                mode === "direct" ? destination : `${url.replace("/page", "/final")}?case=${key}`;
              const { tab_id } = await run<{ tab_id: number }>([
                "tab",
                "create",
                "--session",
                session,
                "--no-active",
                "--url",
                source === "restricted" ? "chrome://newtab/" : url.replace("/page", "/source"),
              ]);
              const scope = ["--session", session, "--tab-id", String(tab_id)];
              const checkInactive = async () => {
                const { tabs } = await run<{ tabs: { tab_id: number; active: boolean }[] }>([
                  "tab",
                  "list",
                  "--session",
                  session!,
                  "--scope",
                  "agent",
                ]);
                expect(tabs.find((tab) => tab.tab_id === tab_id)?.active).toBe(false);
              };
              await checkInactive();
              const result = await run<{ reached: string; final_url: string }>([
                "navigate",
                destination,
                ...scope,
                "--wait-until",
                phase,
                "--timeout",
                "20s",
              ]);
              expect(result.reached, key).toBe(phase);
              expect(result.final_url, key).toBe(finalUrl);
              expect(requests.has(key)).toBe(true);
              // For load/networkidle, navigation itself cannot finish until rAF has run.
              if (phase === "load" || phase === "networkidle") expect(ready.has(key)).toBe(true);
              const snapshot = await run<{ text: string }>(["snapshot", ...scope]);
              expect(snapshot.text).toContain("Background ready");
              await checkInactive();
              await run(["tab", "close", String(tab_id), "--session", session]);
            }
          }
        }
      } finally {
        try {
          if (session) await run(["session", "stop", session]);
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
    }, 180_000);
  },
);
