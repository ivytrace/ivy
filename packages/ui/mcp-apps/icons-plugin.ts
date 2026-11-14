import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const ID = "virtual:ivy-service-icons";

/** Strips what a 16-40 px icon doesn't need: prolog, titles, IDs, comments, excess precision, whitespace. */
export function minifySvg(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/\s(id|xmlns:xlink|version)="[^"]*"/g, "")
    .replace(/(\d+\.\d{2})\d+/g, "$1")
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function load(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith(".svg"))
      .map((f) => [f.slice(0, -4), `data:image/svg+xml,${encodeURIComponent(minifySvg(readFileSync(path.join(dir, f), "utf8")))}`]),
  );
}

/**
 * `virtual:ivy-service-icons`: the dashboard's service icons as minified data URIs (views can't load
 * files). Only the sets a view uses are included: `mini` (rows) always, `large` (graph nodes) on request.
 */
export function serviceIcons(publicDir: string, sets: { large: boolean }): Plugin {
  return {
    name: "ivy-service-icons",
    resolveId: (id) => (id === ID ? `\0${ID}` : undefined),
    load(id) {
      if (id !== `\0${ID}`) return undefined;
      const mini = load(path.join(publicDir, "images/service-icons-mini"));
      const large = sets.large ? load(path.join(publicDir, "images/service-icons")) : {};
      return `export const mini = ${JSON.stringify(mini)};\nexport const large = ${JSON.stringify(large)};\n`;
    },
  };
}
