import fs from "node:fs";

const data = JSON.parse(fs.readFileSync("F:/aigc/aigc/TapCanvas/.scratch/nasa_initial.json", "utf8"));

const hits = [];
function walk(node, path) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, `${path}[${index}]`));
    return;
  }
  if (node.lockupViewModel) {
    hits.push({ path, keys: Object.keys(node.lockupViewModel), view: node.lockupViewModel });
  }
  for (const [key, value] of Object.entries(node)) {
    walk(value, `${path}.${key}`);
  }
}
walk(data, "$");
console.log("hits", hits.length);
const first = hits[1]?.view ?? hits[0]?.view;
console.log(JSON.stringify({ path: hits[1]?.path, contentId: first?.contentId, metadata: first?.metadata, contentType: first?.contentType }, null, 2).slice(0, 2000));
