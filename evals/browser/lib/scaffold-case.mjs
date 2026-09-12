import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { casesDirectory, evalDirectory } from "./paths.mjs";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function moduleSpecifier(fromDirectory, target) {
  const path = relative(await realpath(fromDirectory), await realpath(target))
    .split(sep)
    .join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

export async function scaffoldCase({
  id,
  title = id,
  suite = "regression",
  source,
  rootCasesDirectory = casesDirectory,
}) {
  if (!ID_PATTERN.test(id ?? "")) throw new Error("case id must use lowercase kebab-case");
  if (!ID_PATTERN.test(suite ?? "")) throw new Error("suite must use lowercase kebab-case");
  const directory = join(rootCasesDirectory, suite, id);
  if (await exists(directory)) throw new Error(`case directory already exists: ${directory}`);
  await mkdir(directory, { recursive: true });

  const marker = `CASE-${id.toUpperCase().replaceAll("-", "_")}`;
  const startPath = `/cases/${id}`;
  const manifest = {
    $schema: "../../../schemas/case.schema.json",
    schemaVersion: 1,
    id,
    title,
    order: 10,
    suite,
    tags: ["badcase", "regression"],
    ...(source ? { source: { type: "user-badcase", reference: source } } : {}),
    fixture: { startPath },
    prompts: {
      en: `Open {url}, complete the minimal regression scenario, report ${marker}, and close the browser session.`,
      "zh-CN": `打开 {url}，完成最小回归场景，报告 ${marker}，最后关闭浏览器会话。`,
    },
    coverage: ["session.start", "session.stop", "page.navigate", "inspect.observe"],
    assertions: {
      site: [
        {
          label: "regression fixture was displayed",
          type: "page.shown",
          where: { "data.path": startPath },
          minCount: 1,
        },
      ],
      response: [{ label: "reported regression marker", includes: marker }],
      adapter: [{ label: "browser session was closed", key: "sessionStopped" }],
    },
    smoke: { steps: [{ action: "navigate" }, { action: "observe" }] },
  };

  const fixtureHelper = await moduleSpecifier(
    directory,
    join(evalDirectory, "lib", "fixtures.mjs"),
  );
  const fixture = `import { escapeHtml, page } from ${JSON.stringify(fixtureHelper)};

const title = ${JSON.stringify(title)};

export default {
  id: ${JSON.stringify(id)},
  routes: [${JSON.stringify(startPath)}],
  render() {
    return page({
      title,
      body: \`<section class="card"><h1>\${escapeHtml(title)}</h1><p class="marker">${marker}</p><p>Replace this page with a privacy-safe minimal reproduction.</p></section>\`,
    });
  },
};
`;
  const readme = `# ${title}

## Original symptom

Describe what the user observed without including private data or proprietary page content.

## Minimal reproduction

Explain the smallest DOM, timing, or browser-state condition that reproduces the failure.

## Expected behavior

Describe the observable success condition and update the case assertions accordingly.

## Regression history

- Source: ${source ?? "add issue, PR, or anonymized user report reference"}
- Fix: add the fixing PR when available
`;

  const files = {
    manifest: join(directory, `${id}.case.json`),
    fixture: join(directory, `${id}.fixture.mjs`),
    readme: join(directory, "README.md"),
  };
  await Promise.all([
    writeFile(files.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" }),
    writeFile(files.fixture, fixture, { flag: "wx" }),
    writeFile(files.readme, readme, { flag: "wx" }),
  ]);
  return { directory, files };
}
