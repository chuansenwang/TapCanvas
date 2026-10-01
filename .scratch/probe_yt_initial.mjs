import fs from "node:fs";

const html = fs.readFileSync("F:/aigc/aigc/TapCanvas/.scratch/nasa_videos.html", "utf8");
const marker = html.match(/ytInitialData\s*=\s*\{/);
if (!marker) {
  throw new Error("ytInitialData not found");
}
const start = html.indexOf("{", marker.index);
let depth = 0;
let inString = false;
let escaped = false;
let end = -1;
for (let i = start; i < html.length; i += 1) {
  const ch = html[i];
  if (inString) {
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === '"') {
      inString = false;
    }
    continue;
  }
  if (ch === '"') {
    inString = true;
  } else if (ch === "{") {
    depth += 1;
  } else if (ch === "}") {
    depth -= 1;
    if (depth === 0) {
      end = i;
      break;
    }
  }
}
if (end < 0) {
  throw new Error("unbalanced ytInitialData");
}
const data = JSON.parse(html.slice(start, end + 1));
fs.writeFileSync("F:/aigc/aigc/TapCanvas/.scratch/nasa_initial.json", JSON.stringify(data));
console.log("parsed ok");
