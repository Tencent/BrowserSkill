import { pathToFileURL } from "node:url";

import { discoverFiles } from "./discovery.mjs";
import { casesDirectory, fixturesDirectory } from "./paths.mjs";

export async function loadFixtureRegistry({ roots = [fixturesDirectory, casesDirectory] } = {}) {
  const files = (
    await Promise.all(
      roots.map((root) => discoverFiles(root, (path) => path.endsWith(".fixture.mjs"))),
    )
  ).flat();
  const routes = new Map();
  const definitions = [];
  const errors = [];

  for (const file of files.sort()) {
    let definition;
    try {
      definition = (await import(pathToFileURL(file).href)).default;
    } catch (error) {
      errors.push(`${file}: could not import fixture: ${error.message}`);
      continue;
    }
    if (!definition || typeof definition.id !== "string") {
      errors.push(`${file}: default export must define id`);
      continue;
    }
    if (!Array.isArray(definition.routes) || definition.routes.length === 0) {
      errors.push(`${file}: default export must define non-empty routes`);
      continue;
    }
    if (typeof definition.render !== "function") {
      errors.push(`${file}: default export must define render(context)`);
      continue;
    }
    definitions.push({ ...definition, sourceFile: file });
    for (const route of definition.routes) {
      if (typeof route !== "string" || !route.startsWith("/")) {
        errors.push(`${file}: invalid route ${JSON.stringify(route)}`);
      } else if (routes.has(route)) {
        errors.push(
          `${file}: route ${route} is already registered by ${routes.get(route).sourceFile}`,
        );
      } else {
        routes.set(route, { definition, sourceFile: file });
      }
    }
  }

  if (errors.length > 0) throw new Error(`fixture validation failed:\n${errors.join("\n")}`);
  return Object.freeze({
    definitions: Object.freeze(definitions),
    routes: Object.freeze([...routes.keys()].sort()),
    hasRoute(pathname) {
      return routes.has(pathname);
    },
    render(pathname, context) {
      const entry = routes.get(pathname);
      return entry ? entry.definition.render({ ...context, pathname }) : null;
    },
  });
}

export function validateCaseFixtureLinks(cases, fixtureRegistry) {
  return cases
    .filter(({ startPath }) => !fixtureRegistry.hasRoute(startPath))
    .map(({ id, startPath }) => `case ${id} references unregistered fixture route ${startPath}`);
}
