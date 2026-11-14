import type { AwsAccount, AwsFunction, AwsSetup, TraceState } from "../api/types.ts";
import { FUNCTIONS } from "./fixtures.ts";

export interface MockOptions {
  /** Start without connected accounts or trace data (VITE_MOCK_EMPTY=1). */
  empty?: boolean;
  /** No IVY_CFN_TEMPLATE_URL: the connect flow shows the download fallback (VITE_MOCK_NO_TEMPLATE=1). */
  noTemplate?: boolean;
}

interface MockAccount extends Omit<AwsAccount, "syncing" | "counts" | "quick_create_url"> {
  created_ms: number;
  sync_until: number;
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

type FnSeed = [name: string, region: string, runtime: string, state: TraceState, reason?: string];

const PROD_FUNCTIONS: FnSeed[] = [
  ...FUNCTIONS.map((f): FnSeed => [f.name, f.region, "nodejs22.x", "traced"]),
  ["checkout-refundOrder", "eu-west-1", "nodejs22.x", "traced"],
  ["checkout-webhookStripe", "eu-west-1", "nodejs20.x", "traced"],
  ["orders-archive", "eu-west-1", "nodejs20.x", "opted_out", "Turned off in the dashboard"],
  ["auth-tokenRefresh", "eu-central-1", "nodejs22.x", "opted_out", "Tagged ivy:trace=false"],
  ["auth-legacySaml", "eu-central-1", "nodejs16.x", "unsupported", "Runtime nodejs16.x is not supported"],
  ["reports-pdfRender", "us-east-1", "python3.12", "unsupported", "Runtime python3.12 is not supported"],
  ["reports-imageResize", "us-east-1", "", "unsupported", "Container image functions do not support layers"],
  ["search-indexer", "us-east-1", "nodejs22.x", "conflict", "AWS_LAMBDA_EXEC_WRAPPER is already set to /opt/datadog_wrapper"],
  ["media-transcode", "us-east-1", "nodejs20.x", "conflict", "Already uses 5 layers, the Lambda maximum"],
];

const STAGING_FUNCTIONS: FnSeed[] = [
  ["checkout-createOrder-staging", "eu-west-1", "nodejs22.x", "traced"],
  ["orders-processQueue-staging", "eu-west-1", "nodejs22.x", "traced"],
  ["legacy-import", "eu-west-1", "nodejs18.x", "error", "Update failed: KMS key arn:aws:kms:eu-west-1:210987654321:key/… is not accessible"],
  ["ops-backfill", "eu-west-1", "nodejs22.x", "pending", "Couldn't read tags (tag:GetResources)"],
];

const NEW_ACCOUNT_FUNCTIONS = (region: string): FnSeed[] => [
  ["api-handler", region, "nodejs22.x", "traced"],
  ["api-authorizer", region, "nodejs22.x", "traced"],
  ["jobs-worker", region, "nodejs20.x", "traced"],
  ["jobs-scheduler", region, "nodejs20.x", "traced"],
  ["data-export", region, "python3.12", "unsupported", "Runtime python3.12 is not supported"],
];

function makeFunctions(accountId: string, seeds: FnSeed[], ts: number): AwsFunction[] {
  return seeds.map(([name, region, runtime, state, reason]) => ({
    account_id: accountId,
    region,
    name,
    arn: `arn:aws:lambda:${region}:${accountId}:function:${name}`,
    runtime: runtime || "Image",
    state,
    reason: reason ?? null,
    tracing_enabled: !(state === "opted_out" && reason === "Turned off in the dashboard"),
    updated_at: new Date(ts).toISOString(),
  }));
}

function makeAccount(fields: Partial<MockAccount> & Pick<MockAccount, "id" | "name" | "account_id" | "regions" | "stack_region">, now: number): MockAccount {
  const short = fields.id.replace(/\W/g, "").slice(0, 8);
  return {
    role_arn: `arn:aws:iam::${fields.account_id}:role/IvyTrace-${short}`,
    external_id: `ivy-${short.padEnd(32, "0")}`,
    stack_name: `ivy-trace-${short}`,
    all_regions: false,
    status: "connected",
    error: null,
    created_at: new Date(now - 5 * 86_400_000).toISOString(),
    verified_at: new Date(now - 5 * 86_400_000).toISOString(),
    last_sync_at: new Date(now - 2 * 60_000).toISOString(),
    template_download_url: `/api/aws/template.yaml?account=${fields.id}&download=1`,
    throttle_metrics: true,
    throttle_status: "ok",
    created_ms: now - 5 * 86_400_000,
    sync_until: 0,
    ...fields,
  };
}

export function createAwsMock(options: MockOptions = {}) {
  const now = Date.now();
  const accounts: MockAccount[] = [];
  let functions: AwsFunction[] = [];
  let counter = 0;

  if (!options.empty) {
    accounts.push(
      makeAccount({ id: "acc-prod", name: "Production", account_id: "123456789012", regions: ["eu-west-1", "eu-central-1", "us-east-1"], stack_region: "eu-west-1" }, now),
      makeAccount(
        {
          id: "acc-staging",
          name: "Staging",
          account_id: "210987654321",
          regions: ["eu-west-1", "ap-southeast-2"],
          stack_region: "eu-west-1",
          error: "ap-southeast-2: User: arn:aws:sts::210987654321:assumed-role/IvyTrace-accstagi/ivy-trace is not authorized to perform: lambda:ListFunctions",
          last_sync_at: new Date(now - 4 * 60_000).toISOString(),
          throttle_status: "missing_permission",
        },
        now,
      ),
    );
    functions = [...makeFunctions("123456789012", PROD_FUNCTIONS, now), ...makeFunctions("210987654321", STAGING_FUNCTIONS, now)];
  }

  const setup = (): AwsSetup => ({
    principal_arn: PRINCIPAL,
    template_url: options.noTemplate ? null : TEMPLATE_URL,
    events_url: null,
    public_url: null,
    ingest_endpoint: "https://ingest.ivytrace.dev",
    layer_sha256: "3f1c…",
    default_region: "eu-west-1",
    regions: REGIONS,
    sync_interval_seconds: 300,
    issues: [],
  });

  const present = (a: MockAccount): AwsAccount => {
    const { created_ms: _c, sync_until, ...rest } = a;
    const own = functions.filter((f) => f.account_id === a.account_id);
    const counts = { traced: 0, opted_out: 0, unsupported: 0, conflict: 0, error: 0, pending: 0, total: own.length };
    for (const f of own) counts[f.state]++;
    const quick = options.noTemplate
      ? null
      : `https://${a.stack_region}.console.aws.amazon.com/cloudformation/home?region=${a.stack_region}#/stacks/quickcreate?${new URLSearchParams({
          templateURL: TEMPLATE_URL,
          stackName: a.stack_name,
          param_TrustedPrincipalArn: PRINCIPAL,
          param_ExternalId: a.external_id,
          param_RoleName: a.role_arn.split("/").pop()!,
        })}`;
    return { ...rest, syncing: Date.now() < sync_until, counts, quick_create_url: quick };
  };

  const find = (id: string) => accounts.find((a) => a.id === id);
  const startSync = (a: MockAccount) => {
    a.sync_until = Date.now() + SYNC_MS;
    a.last_sync_at = new Date(a.sync_until).toISOString();
  };

  function handle(method: string, path: string, params: URLSearchParams, body: Record<string, unknown>): { status: number; body: unknown; contentType?: string } | null {
    if (path === "/api/aws/setup") return { status: 200, body: setup() };
    if (path === "/api/aws/template.yaml") {
      return { status: 200, contentType: "text/yaml", body: "# Mock mode: the real template comes from GET /api/aws/template.yaml on the API.\nAWSTemplateFormatVersion: 2010-09-09\nResources: {}\n" };
    }
    if (path === "/api/aws/accounts" && method === "GET") return { status: 200, body: { items: accounts.map(present) } };
    if (path === "/api/aws/accounts" && method === "POST") {
      const accountId = String(body.account_id ?? "").replace(/[\s-]/g, "");
      if (!/^\d{12}$/.test(accountId)) return { status: 400, body: { error: "account_id must be a 12-digit AWS account ID" } };
      if (accounts.some((a) => a.account_id === accountId)) return { status: 409, body: { error: `AWS account ${accountId} is already connected` } };
      const stackRegion = String(body.stack_region || "eu-west-1");
      const id = `acc-new${++counter}`;
      const account = makeAccount(
        {
          id,
          name: typeof body.name === "string" && body.name ? body.name : `AWS ${accountId}`,
          account_id: accountId,
          regions: Array.isArray(body.regions) ? (body.regions as string[]) : [stackRegion],
          all_regions: body.all_regions === true,
          stack_region: stackRegion,
          status: "pending",
          created_at: new Date().toISOString(),
          verified_at: null,
          last_sync_at: null,
          throttle_metrics: body.throttle_metrics !== false,
          throttle_status: null,
          created_ms: Date.now(),
        },
        Date.now(),
      );
      accounts.push(account);
      return { status: 201, body: present(account) };
    }
    if (path === "/api/aws/functions" && method === "GET") {
      const account = params.get("account");
      return { status: 200, body: { items: functions.filter((f) => !account || f.account_id === account) } };
    }

    const fn = path.match(/^\/api\/aws\/functions\/(\d{12})\/([\w-]+)\/([^/]+)$/);
    if (fn && method === "PUT") {
      const target = functions.find((f) => f.account_id === fn[1] && f.region === fn[2] && f.name === decodeURIComponent(fn[3]));
      if (!target) return { status: 404, body: { error: "Function not found" } };
      const enabled = body.tracing_enabled === true;
      target.tracing_enabled = enabled;
      if (target.state !== "unsupported") {
        target.state = enabled ? "traced" : "opted_out";
        target.reason = enabled ? null : "Turned off in the dashboard";
      }
      target.updated_at = new Date().toISOString();
      return { status: 200, body: { applied: true, error: null, function: target } };
    }

    const m = path.match(/^\/api\/aws\/accounts\/([^/]+)(\/verify|\/sync)?$/);
    if (!m) return null;
    const account = find(m[1]);
    if (!account) return { status: 404, body: { error: "Account not found" } };
    const action = m[2];

    if (action === "/verify" && method === "POST") {
      if (Date.now() - account.created_ms < VERIFY_AFTER_MS) {
        account.error = `Can't assume ${account.role_arn} yet: User: ${PRINCIPAL} is not authorized to perform: sts:AssumeRole on resource: ${account.role_arn}`;
        return { status: 200, body: { verified: false, account: present(account) } };
      }
      account.status = "connected";
      account.error = null;
      account.verified_at = new Date().toISOString();
      account.throttle_status = "ok";
      if (!functions.some((f) => f.account_id === account.account_id)) {
        functions.push(...makeFunctions(account.account_id, NEW_ACCOUNT_FUNCTIONS(account.stack_region), Date.now()));
      }
      startSync(account);
      return { status: 200, body: { verified: true, account: present(account) } };
    }
    if (action === "/sync" && method === "POST") {
      if (account.status === "pending") return { status: 409, body: { error: "Verify the account first" } };
      startSync(account);
      return { status: 202, body: { started: true } };
    }
    if (!action && method === "GET") return { status: 200, body: present(account) };
    if (!action && method === "PATCH") {
      if (Array.isArray(body.regions)) account.regions = body.regions as string[];
      if (typeof body.all_regions === "boolean") account.all_regions = body.all_regions;
      if (typeof body.name === "string" && body.name) account.name = body.name;
      if (typeof body.throttle_metrics === "boolean") account.throttle_metrics = body.throttle_metrics;
      startSync(account);
      return { status: 200, body: present(account) };
    }
    if (!action && method === "DELETE") {
      accounts.splice(accounts.indexOf(account), 1);
      functions = functions.filter((f) => f.account_id !== account.account_id);
      return { status: 200, body: { deleted: true, detached: params.get("detach") !== "false", detach_errors: [] } };
    }
    return { status: 405, body: { error: "Method not allowed" } };
  }

  return { handle };
}
