import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AlertSettings, Project, SlackChannel } from "@/lib/api/types";
import { ApplyResult, ApplyToProjectsForm, describeRule } from "./apply-to-projects";

const rule: AlertSettings = { slack_enabled: true, interval_minutes: 60, every_occurrences: 100, include_throttles: false };
const project = (slug: string, name: string): Project => ({ id: `prj_${slug}`, slug, name, archived: false, created_at: "2026-11-01T00:00:00.000Z" });
const projects = [project("checkout-staging", "Checkout (staging)"), project("billing-api-prod", "Billing API (prod)")];
const channel = (name: string): SlackChannel => ({ id: `slk_${name}`, team_name: "Acme", channel: name, status: "ok", error: null, configuration_url: null, created_at: "2026-11-01T00:00:00.000Z" });
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const checkbox = (s: string, label: string) => new RegExp(`<input[^>]*aria-label="${label.replace(/[()]/g, "\\$&")}"[^>]*>`).exec(s)?.[0] ?? "";

function form(selected: string[], extra: { unsaved?: boolean; settings?: AlertSettings; channels?: SlackChannel[] } = {}) {
  return renderToStaticMarkup(
    <ApplyToProjectsForm
      projects={projects}
      selected={new Set(selected)}
      settings={extra.settings ?? rule}
      channels={extra.channels ?? [channel("#alerts"), channel("oncall")]}
      source="Checkout (prod)"
      unsaved={extra.unsaved ?? false}
      onChange={() => {}}
    />,
  );
}

describe("describeRule", () => {
  it("says what will be copied", () => {
    expect(describeRule(rule)).toBe("Slack messages on. First seen, then at most every 60 minutes or every 100 occurrences. Throttles off");
    expect(describeRule({ slack_enabled: false, interval_minutes: 1, every_occurrences: 1000, include_throttles: true })).toBe(
      "Slack messages off. First seen, then at most every 1 minute or every 1,000 occurrences. Throttles on",
    );
  });
});

describe("apply to other projects", () => {
  it("lists the other projects with Select all, the rule and the shared channels", () => {
    const out = form([]);
    expect(text(out)).toContain("Copied from Checkout (prod)");
    expect(text(out)).toContain("every 60 minutes or every 100 occurrences");
    expect(text(out)).toContain("Slack channels: #alerts, #oncall.");
    expect(text(out)).toContain("removing the app or a channel in Slack affects every project that uses it");
    expect(text(out)).toContain("Channels a project already has are skipped");
    expect(text(out)).toContain("0 of 2 selected");
    expect(text(out)).toContain("Checkout (staging)");
    expect(text(out)).toContain("billing-api-prod");
    expect(checkbox(out, "Select all projects")).not.toContain("checked");
    expect(text(out)).not.toContain("not saved");
  });

  it("says when there are no channels to copy", () => {
    const out = text(form([], { channels: [] }));
    expect(out).toContain("Slack channels: none.");
    expect(out).not.toContain("affects every project");
  });

  it("checks Select all once every project is selected", () => {
    const some = form(["prj_billing-api-prod"]);
    expect(text(some)).toContain("1 of 2 selected");
    expect(checkbox(some, "Apply to Billing API (prod)")).toContain("checked");
    expect(checkbox(some, "Apply to Checkout (staging)")).not.toContain("checked");
    expect(checkbox(some, "Select all projects")).not.toContain("checked");
    expect(checkbox(form(projects.map((p) => p.id)), "Select all projects")).toContain("checked");
  });

  it("warns that unsaved changes are copied but not saved here", () => {
    expect(text(form([], { unsaved: true }))).toContain("Includes changes not saved to Checkout (prod) yet");
  });

  it("shows how many projects were updated", () => {
    const result = { updated: 2, projects: projects.map(({ id, slug, name }) => ({ id, slug, name, channels_added: 2 })), settings: rule, channels_added: 4 };
    const out = renderToStaticMarkup(<ApplyResult result={result} />);
    expect(text(out)).toContain("Updated 2 projects, added 4 Slack channels.");
    expect(text(renderToStaticMarkup(<ApplyResult result={{ ...result, channels_added: 0 }} />))).toContain("Updated 2 projects.");
    expect(text(out)).toContain("Checkout (staging), Billing API (prod)");
  });
});
