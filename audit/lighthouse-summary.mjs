// Summarises Lighthouse JSON reports: category scores and every audit below 0.9.
import { readdirSync, readFileSync } from "node:fs";
const dir = process.argv[2];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const r = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  const cats = Object.values(r.categories).map((c) => `${c.title} ${Math.round(c.score * 100)}`).join(", ");
  console.log(`\n## ${f.replace(".json", "")}  (${r.finalDisplayedUrl})\n${cats}`);
  const m = r.audits;
  for (const k of ["first-contentful-paint", "largest-contentful-paint", "total-blocking-time", "cumulative-layout-shift", "speed-index", "total-byte-weight"]) if (m[k]) console.log(`  ${m[k].title}: ${m[k].displayValue ?? m[k].numericValue}`);
  for (const a of Object.values(m)) if (a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== "informative" && a.scoreDisplayMode !== "manual" && a.scoreDisplayMode !== "notApplicable") console.log(`  - ${a.title} (${a.score})${a.displayValue ? ": " + a.displayValue : ""}`);
}
