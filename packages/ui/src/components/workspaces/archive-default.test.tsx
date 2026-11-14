import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Project } from "@/lib/api/types";
import { ArchiveDefaultNotice, defaultCandidates } from "./archive-default";

const project = (slug: string, name: string, extra: Partial<Project> = {}): Project => ({
  id: `prj_${slug}`,
  slug,
  name,
  archived: false,
  default: false,
  created_at: "2026-11-01T00:00:00.000Z",
  ...extra,
});

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

describe("archiving the default project", () => {
  const def = project("default", "Default", { default: true });
  const prod = project("checkout-prod", "Checkout (prod)");
  const old = project("legacy", "Legacy", { archived: true });

  it("offers the other active projects as the new default", () => {
    expect(defaultCandidates([def, old, prod], def).map((p) => p.slug)).toEqual(["checkout-prod"]);
  });

  it("says which project becomes the default, what goes there, and that the project's keys stop working", () => {
    expect(text(renderToStaticMarkup(<ArchiveDefaultNotice project={def} next={prod} />))).toBe(
      "Checkout (prod) becomes the default project; keys without a project and new auto-traced functions without a rule go there." +
        "Keys created for Default stop working." +
        "Its data stays readable until retention removes it, and you can unarchive it later.",
    );
  });

  it("explains that the last project can't be archived", () => {
    expect(text(renderToStaticMarkup(<ArchiveDefaultNotice project={def} next={undefined} />))).toBe(
      "A workspace needs at least one project. Create another project before archiving Default.",
    );
  });
});
