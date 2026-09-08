// Diagnostic, not a golden test requiring the current quadratic cost to persist.
// Instrument a temporary copy; never modify the production renderer.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const output = process.argv[2];
if (!output || !path.isAbsolute(output))
  throw new Error("Pass an absolute evidence output directory");
const require = createRequire(path.join(root, "apps/extension/package.json"));
const vitestDirectory = path.dirname(require.resolve("vitest/package.json"));
const temporary = await mkdtemp(path.join(os.tmpdir(), "bsk-render-measure-"));
await mkdir(output, { recursive: true });
try {
  const source = await readFile(path.join(root, "packages/vom/src/render.ts"), "utf8");
  let instrumented = source;
  for (const [needle, field] of [
    ["const { node, depth } = stack.pop() as { node: VomNode; depth: number };", "renderVisits"],
    ["for (const candidate of orderedCandidates) {", "contextCandidates"],
    ["for (const sibling of siblings) {", "siblingVisits"],
  ]) {
    assert.equal(instrumented.split(needle).length, 2, `Update measurement site: ${field}`);
    instrumented = instrumented.replace(needle, `${needle} designCounts.${field}++;`);
  }
  instrumented = `export const designCounts = {renderVisits:0,contextCandidates:0,siblingVisits:0};\n${instrumented}`;
  await writeFile(path.join(temporary, "render.ts"), instrumented);
  for (const file of ["layers.ts", "types.ts"])
    await copyFile(path.join(root, "packages/vom/src", file), path.join(temporary, file));
  const reportPath = path.join(output, "render-counts.json");
  await writeFile(
    path.join(temporary, "measure.test.ts"),
    `
import {writeFileSync} from 'node:fs';
import {test,expect} from ${JSON.stringify(path.join(vitestDirectory, "dist/index.js"))};
import {renderVom,designCounts} from './render';
test('measure operation counts',()=>{
  const rows=[];
  const make=(id,extra={})=>({id,parentId:1,backendNodeId:id,tag:'div',role:'generic',rect:{x:0,y:0,w:100,h:20},paintOrder:0,position:'static',pointerEvents:'auto',contextScopeId:'root',...extra});
  const run=(shape,n,nodes)=>{
    Object.assign(designCounts,{renderVisits:0,contextCandidates:0,siblingVisits:0});
    const result=renderVom({viewport:{width:1440,height:1000},nodes},{maxTokens:Infinity});
    rows.push({shape,n,counts:{...designCounts},refs:result.refs.length});
  };
  for(const n of [100,200,400]){
    const nodes=[make(1,{parentId:null,role:'RootWebArea',name:'Doc'})];
    for(let i=0;i<n;i++)nodes.push(make(i+2,{role:'heading',name:'Region '+i,domParentId:1,domAncestorIds:[1]}));
    for(let i=0;i<n;i++)nodes.push(make(n+i+2,{tag:'button',role:'button',name:'View',domParentId:1,domAncestorIds:[1]}));
    run('wide',n,nodes);
  }
  for(const n of [2000,4000]){
    const nodes=[make(1,{parentId:null,role:'RootWebArea',name:'Doc'})];
    for(let i=2;i<=n;i++)nodes.push(make(i,{parentId:i-1}));
    nodes.push(make(n+1,{parentId:n,role:'button',tag:'button',name:'Unique control'}));
    run('deep',n,nodes);
  }
  expect(rows.at(-1).refs).toBe(1);
  writeFileSync(${JSON.stringify(reportPath)},JSON.stringify({sourceSha256:${JSON.stringify(createHash("sha256").update(source).digest("hex"))},rows},null,2));
});
`,
  );
  const config = path.join(temporary, "vitest.config.mjs");
  await writeFile(
    config,
    `export default {test:{environment:'node',include:[${JSON.stringify(path.join(temporary, "measure.test.ts"))}]}};`,
  );
  const result = spawnSync(
    process.execPath,
    [path.join(vitestDirectory, "vitest.mjs"), "run", "--config", config],
    { cwd: root, encoding: "utf8", timeout: 60000 },
  );
  await writeFile(
    path.join(output, "render-measure.log"),
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Measurement failed; see ${output}/render-measure.log`);
  process.stdout.write(`${reportPath}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
