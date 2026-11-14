import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Project } from "@/lib/api/types";
import { ArchiveProjectNotice } from "./archive-project";

const project: Project = { id: "prj_checkout", slug: "checkout-prod", name: "Checkout (prod)", archived: false, created_at: "2026-11-01T00:00:00.000Z" };

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

describe("archiving a project", () => {
  it("says that its keys stop working, its data stays and it can be unarchived", () => {
    expect(text(renderToStaticMarkup(<ArchiveProjectNotice project={project} last={false} />))).toBe(
      "Keys created for Checkout (prod) stop working, and its traced functions are no longer traced." +
        "Its data stays readable until retention removes it, and you can unarchive it later.",
    );
  });

  it("allows archiving the last active project", () => {
    expect(text(renderToStaticMarkup(<ArchiveProjectNotice project={project} last />))).toContain(
      "It is the workspace's last active project: you can create a new one afterwards.",
    );
  });
});
