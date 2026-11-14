import type { AwsAccount, AwsFunction, AwsSetup, DryRunOutcome, FunctionGroup, Rule, RuleMatcher, TraceState } from "../api/types.ts";

export interface MockOptions {
  /** Start without connected accounts or trace data (VITE_MOCK_EMPTY=1). */
  empty?: boolean;
  /** No IVY_CFN_TEMPLATE_URL: the connect flow shows the download fallback (VITE_MOCK_NO_TEMPLATE=1). */
  noTemplate?: boolean;
  /** Usage fixture (VITE_MOCK_USAGE): free under quota (default), near (85%), over (blocked), paid, unlimited. */
  usage?: MockUsage;
  /** Leave out billing.url from /api/config: no billing buttons (VITE_MOCK_NO_BILLING=1). */
  noBilling?: boolean;
  /** Neither Slack nor email configured on the server: alerts settings explain why (VITE_MOCK_NO_ALERTS=1). */
  noAlerts?: boolean;
}

export type MockUsage = "free" | "near" | "over" | "paid" | "unlimited";

interface MockAccount extends Omit<AwsAccount, "syncing" | "counts" | "quick_create_url" | "quick_create_error"> {
  created_ms: number;
  sync_until: number;
}

/** A function as the mock "AWS" has it; its state is derived from tags, manual choices and rules. */
interface MockFunction {
  account_id: string;
  region: string;
  name: string;
  runtime: string;
  tags: Record<string, string>;
  /** States the attach logic decides regardless of the selection. */
  fixed?: { state: Exclude<TraceState, "traced" | "available" | "opted_out">; reason: string };
  first_seen_ms: number;
  last_modified: string;
}

interface Manual {
  mode: "trace" | "exclude";
  project_id: string | null;
}

interface MockRule {
  id: string;
  matcher: Rule["matcher"];
  project_id: string;
  enabled: boolean;
  created_at: string;
}

const REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "eu-central-1", "eu-west-1", "eu-west-2",
  "eu-west-3", "eu-north-1", "eu-south-1", "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
  "ap-northeast-2", "sa-east-1",
];
const PRINCIPAL = "arn:aws:iam::999999999999:role/ivy-trace-hosted";
const TEMPLATE_URL = "https://ivy-trace-templates.s3.amazonaws.com/ivy-trace.yaml";
const VERIFY_AFTER_MS = 8_000;
const SYNC_MS = 4_000;
const DAY = 86_400_000;
const STACK_TAG = "aws:cloudformation:stack-name";

type Seed = [name: string, region: string, runtime: string, stack: string | null, extra?: Partial<MockFunction>];

const PROD: Seed[] = [
  ["checkout-createOrder", "eu-west-1", "nodejs22.x", "checkout-prod"],
  ["checkout-refundOrder", "eu-west-1", "nodejs22.x", "checkout-prod"],
  ["checkout-webhookStripe", "eu-west-1", "nodejs20.x", "checkout-prod"],
  ["orders-processQueue", "eu-west-1", "nodejs22.x", "checkout-prod"],
  ["auth-getProfile", "eu-central-1", "nodejs22.x", "billing-api-prod"],
  ["auth-tokenRefresh", "eu-central-1", "nodejs22.x", "billing-api-prod", { tags: { "ivy:trace": "false" } }],
  ["auth-legacySaml", "eu-central-1", "nodejs16.x", "billing-api-prod", { fixed: { state: "unsupported", reason: "Runtime nodejs16.x is not supported" } }],
  ["reports-nightlyExport", "us-east-1", "nodejs22.x", "billing-api-staging"],
  ["support-answerTicket", "eu-west-1", "nodejs22.x", "support-api-prod"],
  ["staging-api-handler", "us-east-1", "nodejs22.x", "billing-api-staging", { tags: { team: "api" } }],
  ["reports-pdfRender", "us-east-1", "python3.12", "billing-api-staging", { fixed: { state: "unsupported", reason: "Runtime python3.12 is not supported" } }],
  ["search-indexer", "us-east-1", "nodejs22.x", null, { fixed: { state: "conflict", reason: "AWS_LAMBDA_EXEC_WRAPPER is already set to /opt/datadog_wrapper" } }],
  ["media-transcode", "us-east-1", "nodejs20.x", null, { tags: { team: "media" } }],
  ["orders-archive", "eu-west-1", "nodejs20.x", null, { first_seen_ms: Date.now() - 2 * 3600_000 }],
  ["ops-cron", "eu-west-1", "nodejs22.x", null, { first_seen_ms: Date.now() - 3 * 3600_000, tags: { team: "ops" } }],
  ["reports-imageResize", "us-east-1", "", null, { fixed: { state: "unsupported", reason: "Container image functions do not support layers" } }],
];

const STAGING: Seed[] = [
  ["checkout-createOrder-staging", "eu-west-1", "nodejs22.x", "checkout-staging"],
  ["orders-processQueue-staging", "eu-west-1", "nodejs22.x", "checkout-staging"],
  ["billing-invoice", "eu-west-1", "nodejs22.x", "billing-dev"],
  ["billing-sync", "eu-west-1", "nodejs20.x", "billing-dev"],
  ["legacy-import", "eu-west-1", "nodejs18.x", null, { fixed: { state: "error", reason: "Can't read environment variables: KMS key is not accessible" } }],
  ["ops-backfill", "eu-west-1", "nodejs22.x", null, { fixed: { state: "pending", reason: "Couldn't read tags (tag:GetResources)" } }],
];

const NEW_ACCOUNT = (region: string): Seed[] => [
  ["api-handler", region, "nodejs22.x", "my-app-prod"],
  ["api-authorizer", region, "nodejs22.x", "my-app-prod"],
  ["jobs-worker", region, "nodejs20.x", null],
  ["data-export", region, "python3.12", null, { fixed: { state: "unsupported", reason: "Runtime python3.12 is not supported" } }],
];

function makeFunctions(accountId: string, seeds: Seed[], now: number): MockFunction[] {
  return seeds.map(([name, region, runtime, stack, extra]) => ({
    account_id: accountId,
    region,
    name,
    runtime: runtime || "Image",
    first_seen_ms: now - 5 * DAY,
    last_modified: new Date(now - (name.length % 9) * DAY - 3600_000).toISOString(),
    ...extra,
    tags: { ...(stack ? { [STACK_TAG]: stack } : {}), ...extra?.tags },
  }));
}

export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return re.test(value);
}

export function matches(m: RuleMatcher, fn: Pick<MockFunction, "account_id" | "region" | "name" | "tags">): boolean {
  if (!m.account_id && !m.region && !m.stack && !m.name && !m.tag) return false;
  if (m.account_id && m.account_id !== fn.account_id) return false;
  if (m.region && m.region !== fn.region) return false;
  if (m.stack && !globMatch(m.stack, fn.tags[STACK_TAG] ?? "")) return false;
  if (m.name && !globMatch(m.name, fn.name)) return false;
  if (m.tag) {
    const [k, v] = m.tag.split("=", 2);
    if (fn.tags[k] === undefined) return false;
    if (v !== undefined && !globMatch(v, fn.tags[k])) return false;
  }
  return true;
}

const fnKey = (f: { account_id: string; region: string; name: string }) => `${f.account_id}/${f.region}/${f.name}`;

/** One workspace's AWS state. `projects` resolves project IDs and slugs (active projects only). */
export function createAwsMock(options: MockOptions, projects: () => { id: string; slug: string; archived: boolean; default: boolean }[], workspaceSlug: () => string) {
  const now = Date.now();
  const accounts: MockAccount[] = [];
  let functions: MockFunction[] = [];
  const manual = new Map<string, Manual>();
  let rules: MockRule[] = [];
  let counter = 0;

  const projectBy = (ref: string | null | undefined) => projects().find((p) => !p.archived && (p.id === ref || p.slug === ref));
  const defaultProject = () => projects().find((p) => p.default)!;

  function makeAccount(fields: Partial<MockAccount> & Pick<MockAccount, "id" | "name" | "account_id" | "regions" | "stack_region">, at: number): MockAccount {
    const short = fields.id.replace(/\W/g, "").slice(0, 8);
    return {
      role_arn: `arn:aws:iam::${fields.account_id}:role/IvyTrace-${short}`,
      external_id: `ivy-${short.padEnd(32, "0")}`,
      stack_name: `ivy-trace-${short}`,
      default_project_id: null,
      default_project: null,
      all_regions: false,
      status: "connected",
      error: null,
      created_at: new Date(at - 5 * DAY).toISOString(),
      verified_at: new Date(at - 5 * DAY).toISOString(),
      last_sync_at: new Date(at - 2 * 60_000).toISOString(),
      reviewed_at: new Date(at - DAY).toISOString(),
      template_download_url: "",
      throttle_metrics: true,
      throttle_status: "ok",
      created_ms: at - 5 * DAY,
      sync_until: 0,
      ...fields,
    };
  }

  function seed() {
    if (options.empty || workspaceSlug() !== "acme") return;
    const p = (slug: string) => projectBy(slug)!.id;
    accounts.push(
      makeAccount({ id: "acc-prod", name: "Production", account_id: "123456789012", regions: ["eu-west-1", "eu-central-1", "us-east-1"], stack_region: "eu-west-1" }, now),
      makeAccount(
        {
          id: "acc-staging",
          name: "Staging",
          account_id: "210987654321",
          regions: ["eu-west-1", "ap-southeast-2"],
          stack_region: "eu-west-1",
          reviewed_at: null,
          error: "ap-southeast-2: User: arn:aws:sts::210987654321:assumed-role/IvyTrace-accstagi/ivy-trace is not authorized to perform: lambda:ListFunctions",
          last_sync_at: new Date(now - 4 * 60_000).toISOString(),
          throttle_status: "missing_permission",
        },
        now,
      ),
    );
    accounts[0].default_project_id = p("checkout-prod");
    functions = [...makeFunctions("123456789012", PROD, now), ...makeFunctions("210987654321", STAGING, now)];
    rules = [
      { id: "rul_checkout_prod", matcher: { account_id: null, region: null, stack: "checkout-prod", name: null, tag: null }, project_id: p("checkout-prod"), enabled: true, created_at: new Date(now - 20 * DAY).toISOString() },
      { id: "rul_billing_api_prod", matcher: { account_id: null, region: null, stack: "billing-api-prod", name: null, tag: null }, project_id: p("billing-api-prod"), enabled: true, created_at: new Date(now - 15 * DAY).toISOString() },
      { id: "rul_support_api_prod", matcher: { account_id: null, region: null, stack: "support-api-prod", name: null, tag: null }, project_id: p("support-api-prod"), enabled: true, created_at: new Date(now - 10 * DAY).toISOString() },
      { id: "rul_team_media", matcher: { account_id: null, region: null, stack: null, name: null, tag: "team=media" }, project_id: p("checkout-prod"), enabled: false, created_at: new Date(now - 5 * DAY).toISOString() },
    ];
    manual.set("123456789012/us-east-1/reports-nightlyExport", { mode: "trace", project_id: p("billing-api-staging") });
  }
  seed();

  /** The same precedence as the API (assign.ts): tags, manual choice, rules, otherwise available. */
  function assign(fn: MockFunction, ruleList = rules) {
    if (fn.fixed) return { state: fn.fixed.state, reason: fn.fixed.reason, project: null as string | null, source: null as AwsFunction["source"], rule: null as string | null };
    const tagProject = projectBy(fn.tags["ivy:project"])?.id;
    const m = manual.get(fnKey(fn));
    const rule = ruleList.find((r) => r.enabled && projectBy(r.project_id) && matches(r.matcher, fn));
    if (fn.tags["ivy:trace"] === "false") return { state: "opted_out" as const, reason: "Tagged ivy:trace=false", project: null, source: "tag" as const, rule: null };
    if (fn.tags["ivy:trace"] === "true") return { state: "traced" as const, reason: null, project: tagProject ?? defaultProject().id, source: "tag" as const, rule: null };
    if (m?.mode === "exclude") return { state: "opted_out" as const, reason: "Excluded in the dashboard", project: null, source: "manual" as const, rule: null };
    if (m?.mode === "trace") return { state: "traced" as const, reason: null, project: tagProject ?? projectBy(m.project_id)?.id ?? defaultProject().id, source: "manual" as const, rule: null };
    if (rule) return { state: "traced" as const, reason: null, project: tagProject ?? rule.project_id, source: "rule" as const, rule: rule.id };
    return { state: "available" as const, reason: "Not selected for tracing", project: null, source: null, rule: null };
  }

  const reviewedMs = (accountId: string) => {
    const a = accounts.find((x) => x.account_id === accountId);
    return a?.reviewed_at ? Date.parse(a.reviewed_at) : 0;
  };

  function present(fn: MockFunction): AwsFunction {
    const a = assign(fn);
    const m = manual.get(fnKey(fn));
    const slug = (id: string | null | undefined) => (id ? (projects().find((p) => p.id === id)?.slug ?? null) : null);
    return {
      account_id: fn.account_id,
      region: fn.region,
      name: fn.name,
      arn: `arn:aws:lambda:${fn.region}:${fn.account_id}:function:${fn.name}`,
      runtime: fn.runtime,
      stack: fn.tags[STACK_TAG] ?? null,
      tags: fn.tags,
      last_modified: fn.last_modified,
      state: a.state,
      reason: a.state === "traced" ? null : a.reason,
      project_id: a.project,
      project: slug(a.project),
      source: a.source,
      rule_id: a.rule,
      manual: m ? { mode: m.mode, project_id: m.project_id, project: slug(m.project_id) } : null,
      new: a.state === "available" && fn.first_seen_ms > reviewedMs(fn.account_id),
      first_seen_at: new Date(fn.first_seen_ms).toISOString(),
      updated_at: new Date(now).toISOString(),
    };
  }

  function presentRule(r: MockRule, position: number): Rule {
    return { id: r.id, position, matcher: r.matcher, project_id: r.project_id, project: projects().find((p) => p.id === r.project_id)?.slug ?? null, enabled: r.enabled, created_at: r.created_at };
  }

  const setup = (): AwsSetup => ({
    principal_arn: PRINCIPAL,
    quick_create: !options.noTemplate,
    events_url: null,
    public_url: null,
    ingest_endpoint: "https://ingest.example.com",
    layer_sha256: "3f1c…",
    default_region: "eu-west-1",
    regions: REGIONS,
    sync_interval_seconds: 300,
    issues: [],
  });

  const presentAccount = (a: MockAccount): AwsAccount => {
    const { created_ms: _c, sync_until, ...rest } = a;
    const own = functions.filter((f) => f.account_id === a.account_id).map(present);
    const counts = { traced: 0, available: 0, opted_out: 0, unsupported: 0, conflict: 0, error: 0, pending: 0, total: own.length, new: 0 };
    for (const f of own) {
      counts[f.state]++;
      if (f.new) counts.new++;
    }
    const quick = options.noTemplate
      ? null
      : `https://${a.stack_region}.console.aws.amazon.com/cloudformation/home?region=${a.stack_region}#/stacks/quickcreate?${new URLSearchParams({
          templateURL: TEMPLATE_URL,
          stackName: a.stack_name,
          param_TrustedPrincipalArn: PRINCIPAL,
          param_ExternalId: a.external_id,
          param_RoleName: a.role_arn.split("/").pop()!,
        })}`;
    const dp = projects().find((p) => p.id === a.default_project_id);
    return {
      ...rest,
      default_project: dp?.slug ?? null,
      template_download_url: `/api/w/${workspaceSlug()}/aws/template.yaml?account=${a.id}&download=1`,
      syncing: Date.now() < sync_until,
      counts,
      quick_create_url: quick,
      quick_create_error: null,
    };
  };

  function groups(accountId: string): FunctionGroup[] {
    const own = functions.filter((f) => f.account_id === accountId).map(present);
    const byKey = new Map<string, AwsFunction[]>();
    for (const f of own) {
      const k = f.stack ? `${f.stack}\u0000${f.region}` : "";
      byKey.set(k, [...(byKey.get(k) ?? []), f]);
    }
    return [...byKey.keys()]
      .sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
      .map((k) => {
        const fns = byKey.get(k)!.sort((a, b) => a.name.localeCompare(b.name));
        const [stack, region] = k ? k.split("\u0000") : [null, null];
        const rule = stack
          ? rules.find((r) => r.matcher.stack === stack && !r.matcher.name && !r.matcher.tag && (!r.matcher.account_id || r.matcher.account_id === accountId) && (!r.matcher.region || r.matcher.region === region))
          : undefined;
        return {
          stack,
          region,
          counts: {
            total: fns.length,
            traced: fns.filter((f) => f.state === "traced").length,
            available: fns.filter((f) => f.state === "available").length,
            new: fns.filter((f) => f.new).length,
          },
          rule: rule ? { id: rule.id, project_id: rule.project_id, project: presentRule(rule, 0).project, enabled: rule.enabled } : null,
          suggested_project: stack ? stack.toLowerCase().replace(/[^a-z0-9]+/g, "-") : null,
          functions: fns,
        };
      });
  }

  function dryRun(matcher: RuleMatcher, project: string | undefined) {
    const known = projectBy(project);
    const pid = known?.id ?? (project ? `__new:${project}` : defaultProject().id);
    const probe: MockRule = { id: "__probe", matcher: { account_id: null, region: null, stack: null, name: null, tag: null, ...matcher }, project_id: pid, enabled: true, created_at: "" };
    const items = functions
      .filter((f) => matches(matcher, f))
      .map((f) => {
        const before = present(f);
        const after = assign(f, [...rules, { ...probe, project_id: known?.id ?? pid }]);
        const ruleHit = after.rule === "__probe" || (!known && !after.rule && after.state === "available" && project);
        let outcome: DryRunOutcome;
        if (f.fixed) outcome = "unsupported";
        else if (after.state === "opted_out") outcome = "excluded";
        else if (before.state === "traced" && (after.project === before.project_id || (ruleHit && before.project === project))) outcome = "unchanged";
        else if (ruleHit || after.rule === "__probe") outcome = "trace";
        else if (after.state === "traced") outcome = "other";
        else outcome = "trace";
        return { function: before, outcome, project: outcome === "trace" || outcome === "unchanged" ? (known?.slug ?? project ?? defaultProject().slug) : before.project };
      });
    const summary: Record<DryRunOutcome, number> = { trace: 0, unchanged: 0, excluded: 0, other: 0, unsupported: 0 };
    for (const i of items) summary[i.outcome]++;
    return { count: items.length, summary, items };
  }

  const find = (id: string) => accounts.find((a) => a.id === id);
  const startSync = (a: MockAccount) => {
    a.sync_until = Date.now() + SYNC_MS;
    a.last_sync_at = new Date(a.sync_until).toISOString();
  };
  const ruleId = () => `rul_mock${++counter}`;
  const cleanMatcher = (m: Record<string, unknown>): Rule["matcher"] => ({
    account_id: (m.account_id as string) || null,
    region: (m.region as string) || null,
    stack: (m.stack as string) || null,
    name: (m.name as string) || null,
    tag: (m.tag as string) || null,
  });

  function handle(method: string, path: string, params: URLSearchParams, body: Record<string, unknown>): { status: number; body: unknown; contentType?: string } | null {
    if (path === "/setup") return { status: 200, body: setup() };
    if (path === "/template.yaml") {
      return { status: 200, contentType: "text/yaml", body: "# Mock mode: the real template comes from the API.\nAWSTemplateFormatVersion: 2010-09-09\nResources: {}\n" };
    }
    if (path === "/accounts" && method === "GET") return { status: 200, body: { items: accounts.map(presentAccount) } };
    if (path === "/accounts" && method === "POST") {
      const accountId = String(body.account_id ?? "").replace(/[\s-]/g, "");
      if (!/^\d{12}$/.test(accountId)) return { status: 400, body: { error: "account_id must be a 12-digit AWS account ID" } };
      if (accounts.some((a) => a.account_id === accountId)) return { status: 409, body: { error: `AWS account ${accountId} is already connected to this workspace` } };
      const stackRegion = String(body.stack_region || "eu-west-1");
      const account = makeAccount(
        {
          id: `acc-new${++counter}`,
          name: typeof body.name === "string" && body.name ? body.name : `AWS ${accountId}`,
          account_id: accountId,
          regions: Array.isArray(body.regions) ? (body.regions as string[]) : [stackRegion],
          all_regions: body.all_regions === true,
          stack_region: stackRegion,
          default_project_id: projectBy(body.default_project as string)?.id ?? null,
          status: "pending",
          created_at: new Date().toISOString(),
          verified_at: null,
          last_sync_at: null,
          reviewed_at: null,
          throttle_metrics: body.throttle_metrics !== false,
          throttle_status: null,
          created_ms: Date.now(),
        },
        Date.now(),
      );
      accounts.push(account);
      return { status: 201, body: presentAccount(account) };
    }
    if (path === "/functions" && method === "GET") {
      const account = params.get("account");
      const project = projectBy(params.get("project"));
      const state = params.get("state");
      const items = functions
        .filter((f) => !account || f.account_id === account)
        .map(present)
        .filter((f) => (!project || f.project_id === project.id) && (!state || f.state === state));
      return { status: 200, body: { items } };
    }
    if (path === "/functions/bulk" && method === "POST") {
      const list = (body.functions as { account_id: string; region: string; name: string }[]) ?? [];
      for (const f of list) {
        if (body.mode === "rules") manual.delete(fnKey(f));
        else manual.set(fnKey(f), { mode: body.mode as "trace" | "exclude", project_id: body.mode === "trace" ? (projectBy(body.project as string)?.id ?? null) : null });
      }
      for (const a of accounts) if (list.some((f) => f.account_id === a.account_id)) startSync(a);
      return { status: 202, body: { updated: list.length } };
    }
    const fn = path.match(/^\/functions\/(\d{12})\/([\w-]+)\/([^/]+)$/);
    if (fn && method === "PUT") {
      const target = functions.find((f) => f.account_id === fn[1] && f.region === fn[2] && f.name === decodeURIComponent(fn[3]));
      if (!target) return { status: 404, body: { error: "Function not found" } };
      if (!["trace", "exclude", "rules"].includes(String(body.mode))) return { status: 400, body: { error: 'mode must be "trace", "exclude" or "rules"' } };
      if (body.mode === "rules") manual.delete(fnKey(target));
      else manual.set(fnKey(target), { mode: body.mode as "trace" | "exclude", project_id: body.mode === "trace" ? (projectBy(body.project as string)?.id ?? null) : null });
      return { status: 200, body: { applied: true, error: null, function: present(target) } };
    }

    if (path === "/rules" && method === "GET") return { status: 200, body: { items: rules.map(presentRule) } };
    if (path === "/rules/dry-run" && method === "POST") {
      const m = (body.matcher ?? {}) as RuleMatcher;
      if (!m.account_id && !m.region && !m.stack && !m.name && !m.tag) return { status: 400, body: { error: "matcher needs at least one field" } };
      return { status: 200, body: dryRun(m, body.project as string | undefined) };
    }
    if (path === "/rules" && method === "POST") {
      return { status: 501, body: { error: "handled by the server (needs projects)" } };
    }
    if (path === "/rules/order" && method === "PUT") {
      const order = (body.order as string[]) ?? [];
      rules = [...order.map((id) => rules.find((r) => r.id === id)).filter((r): r is MockRule => !!r), ...rules.filter((r) => !order.includes(r.id))];
      return { status: 200, body: { items: rules.map(presentRule) } };
    }
    const rule = path.match(/^\/rules\/([^/]+)$/);
    if (rule) {
      const r = rules.find((x) => x.id === rule[1]);
      if (!r) return { status: 404, body: { error: "Rule not found" } };
      if (method === "DELETE") {
        rules = rules.filter((x) => x !== r);
        return { status: 200, body: { deleted: true } };
      }
      if (method === "PATCH") {
        if (typeof body.enabled === "boolean") r.enabled = body.enabled;
        if (body.matcher) r.matcher = cleanMatcher(body.matcher as Record<string, unknown>);
        if (body.project) r.project_id = projectBy(body.project as string)?.id ?? r.project_id;
        return { status: 200, body: presentRule(r, rules.indexOf(r)) };
      }
    }

    const m = path.match(/^\/accounts\/([^/]+)(\/verify|\/sync|\/functions)?$/);
    if (!m) return null;
    const account = find(m[1]);
    if (!account) return { status: 404, body: { error: "Account not found" } };
    const action = m[2];

    if (action === "/functions" && method === "GET") return { status: 200, body: { groups: groups(account.account_id) } };
    if (action === "/verify" && method === "POST") {
      if (Date.now() - account.created_ms < VERIFY_AFTER_MS) {
        account.error = `Can't assume ${account.role_arn} yet: User: ${PRINCIPAL} is not authorized to perform: sts:AssumeRole on resource: ${account.role_arn}`;
        return { status: 200, body: { verified: false, account: presentAccount(account) } };
      }
      account.status = "connected";
      account.error = null;
      account.verified_at = new Date().toISOString();
      account.throttle_status = "ok";
      if (!functions.some((f) => f.account_id === account.account_id)) functions.push(...makeFunctions(account.account_id, NEW_ACCOUNT(account.stack_region), Date.now()));
      startSync(account);
      return { status: 200, body: { verified: true, account: presentAccount(account) } };
    }
    if (action === "/sync" && method === "POST") {
      if (account.status === "pending") return { status: 409, body: { error: "Verify the account first" } };
      startSync(account);
      return { status: 202, body: { started: true } };
    }
    if (!action && method === "GET") return { status: 200, body: presentAccount(account) };
    if (!action && method === "PATCH") {
      const regionsChanged = Array.isArray(body.regions) || typeof body.all_regions === "boolean";
      if (Array.isArray(body.regions)) account.regions = body.regions as string[];
      if (typeof body.all_regions === "boolean") account.all_regions = body.all_regions;
      if (typeof body.name === "string" && body.name) account.name = body.name;
      if (body.default_project !== undefined) account.default_project_id = projectBy(body.default_project as string)?.id ?? null;
      if (body.reviewed === true) account.reviewed_at = new Date().toISOString();
      if (typeof body.throttle_metrics === "boolean") account.throttle_metrics = body.throttle_metrics;
      if (regionsChanged) startSync(account);
      return { status: 200, body: presentAccount(account) };
    }
    if (!action && method === "DELETE") {
      accounts.splice(accounts.indexOf(account), 1);
      functions = functions.filter((f) => f.account_id !== account.account_id);
      return { status: 200, body: { deleted: true, detached: params.get("detach") !== "false", detach_errors: [] } };
    }
    return { status: 405, body: { error: "Method not allowed" } };
  }

  /** Adds a rule (the server creates a new project first when asked). */
  function addRule(matcher: Record<string, unknown>, projectId: string, enabled: boolean): Rule {
    const r: MockRule = { id: ruleId(), matcher: cleanMatcher(matcher), project_id: projectId, enabled, created_at: new Date().toISOString() };
    rules.push(r);
    for (const a of accounts) if (a.status !== "pending") startSync(a);
    return presentRule(r, rules.length - 1);
  }

  return { handle, addRule, hasAccounts: () => accounts.length > 0 };
}
