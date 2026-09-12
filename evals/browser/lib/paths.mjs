import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const evalDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
export const casesDirectory = join(evalDirectory, "cases");
export const fixturesDirectory = join(evalDirectory, "fixtures");
export const schemasDirectory = join(evalDirectory, "schemas");
export const resultsDirectory = join(evalDirectory, "results");
