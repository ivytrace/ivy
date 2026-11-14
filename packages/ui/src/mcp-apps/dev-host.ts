/**
 * Local MCP Apps host for developing and testing the views (`pnpm --filter @ivy/ui mcp-apps:host`).
 * With a trace ID it behaves like a real host: calls the tool on the Ivy MCP server (`/mcp`, proxied
 * to the API), reads the linked `ui://` resource, renders it in a sandboxed iframe and passes the tool
 * input and result over the MCP Apps bridge. Without one it renders the view from the dev server with
 * a fixture trace from @ivy/format.
 */
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";
import { checkoutFailed, importWorker, queueFailed, supportBot, supportBotGenAi } from "@ivy/format/fixtures";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;
const status = (text: string) => ($("#status").textContent = text);
const params = new URLSearchParams(location.search);

let client: Client | undefined;
async function mcp(): Promise<Client> {
  if (client) return client;
  const c = new Client({ name: "ivy-test-host", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL("/mcp", location.href)));
  return (client = c);
}

/** An import still running (or, with `stalled`, past its deadline): the root the extension exports while it runs, no children yet. */
function inProgress(stalled: boolean): typeof checkoutFailed {
  const root = importWorker.spans.find((s) => !s.parent_span_id) ?? importWorker.spans[0];
  const start = Date.now() - (stalled ? 50 * 60_000 : 134_000);
  const lastSeen = stalled ? start + 14 * 60_000 : Date.now();
  return {
    ...importWorker,
    spans: [
      {
        ...root,
        kind: "INTERNAL",
        start: new Date(start).toISOString(),
        end: new Date(lastSeen).toISOString(),
        duration_ms: lastSeen - start,
        status_code: "UNSET",
        status_message: "",
        events: [],
        attributes: {
          "ivy.invocation": "true",
          "ivy.in_progress": "true",
          "faas.invocation_id": root.attributes["faas.invocation_id"] ?? "",
          "ivy.deadline_ms": String(start + 15 * 60_000),
          "ivy.last_seen_ms": String(lastSeen),
        },
      },
    ],
  };
}

const FIXTURES: Record<string, typeof checkoutFailed> = {
  support: supportBot,
  "support-genai": supportBotGenAi,
  import: importWorker,
  "in-progress": inProgress(false),
  "no-completion": inProgress(true),
};

function fixtureResult(tool: string, fixture: string): CallToolResult {
  const trace = FIXTURES[fixture] ?? (tool === "render_graph" ? queueFailed : checkoutFailed);
  return {
    content: [{ type: "text", text: "(fixture) text fallback not computed in the test host" }],
    structuredContent: { workspace: { id: "default", slug: "default", name: "Default" }, trace: { ...trace, omitted_spans: 0 } },
  };
}

async function run() {
  const tool = $<HTMLSelectElement>("[name=tool]").value;
  const traceId = $<HTMLInputElement>("[name=trace]").value.trim();
  const workspace = $<HTMLInputElement>("[name=workspace]").value.trim();
  const dark = $<HTMLInputElement>("[name=dark]").checked;
  document.body.classList.toggle("dark", dark);
  const args = { trace_id: traceId || checkoutFailed.trace_id, ...(workspace ? { workspace } : {}) };

  let result: CallToolResult;
  let source: { srcdoc?: string; src?: string };
  let c: Client | null = null;

  if (traceId) {
    status("calling tool…");
    c = await mcp();
    const { tools } = await c.listTools();
    const uri = (tools.find((t) => t.name === tool)?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri;
    result = (await c.callTool({ name: tool, arguments: args })) as CallToolResult;
    if (!uri) {
      status("tool has no UI resource (views not built?): text only");
      $("#text").textContent = (result.content[0] as { text: string }).text;
      $("#frame").replaceChildren();
      return;
    }
    const resource = await c.readResource({ uri });
    const html = resource.contents[0] && "text" in resource.contents[0] ? resource.contents[0].text : "";
    status(`resource ${uri}: ${(html.length / 1024).toFixed(0)} KB, mimeType ${resource.contents[0]?.mimeType}`);
    source = { srcdoc: html };
  } else {
    result = fixtureResult(tool, $<HTMLSelectElement>("[name=fixture]").value);
    source = { src: `/mcp-apps/${tool === "render_graph" ? "graph" : "waterfall"}.html` };
    status("fixture trace, view from the dev server");
  }
  $("#text").textContent = (result.content[0] as { text: string }).text;
  const iframe = document.createElement("iframe");
  // Real hosts give views an opaque origin; the dev server's module scripts need a same-origin frame.
  iframe.setAttribute("sandbox", source.srcdoc !== undefined ? "allow-scripts" : "allow-scripts allow-same-origin");
  $("#frame").replaceChildren(iframe);

  const bridge = new AppBridge(c, { name: "ivy-test-host", version: "1.0.0" }, { openLinks: {}, serverTools: {}, logging: {} });
  let mode: McpUiDisplayMode = "inline";
  const context = () => ({
    theme: dark ? ("dark" as const) : ("light" as const),
    displayMode: mode,
    availableDisplayModes: ["inline", "fullscreen"] as McpUiDisplayMode[],
    containerDimensions: { width: iframe.clientWidth, maxHeight: 4000 },
    platform: "web" as const,
  });
  bridge.setHostContext(context());
  bridge.onsizechange = ({ height }) => {
    if (height && mode === "inline") iframe.style.height = `${height}px`;
  };
  bridge.onrequestdisplaymode = async ({ mode: wanted }) => {
    mode = wanted === "fullscreen" ? "fullscreen" : "inline";
    iframe.classList.toggle("fullscreen", mode === "fullscreen");
    void bridge.sendHostContextChange({ displayMode: mode });
    return { mode };
  };
  bridge.oninitialized = () => {
    void bridge.sendToolInput({ arguments: args });
    void bridge.sendToolResult(result);
  };
  // Listen before the view loads: it sends ui/initialize as soon as its script runs.
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  if (source.srcdoc !== undefined) iframe.srcdoc = source.srcdoc;
  else iframe.src = source.src!;
}

$("#run").addEventListener("click", () => void run().catch((err) => status(`error: ${err instanceof Error ? err.message : err}`)));
if (params.get("trace")) $<HTMLInputElement>("[name=trace]").value = params.get("trace")!;
if (params.get("tool")) $<HTMLSelectElement>("[name=tool]").value = params.get("tool")!;
if (params.get("fixture")) $<HTMLSelectElement>("[name=fixture]").value = params.get("fixture")!;
if (params.get("dark") === "1") $<HTMLInputElement>("[name=dark]").checked = true;
if (params.has("run")) void run().catch((err) => status(`error: ${err instanceof Error ? err.message : err}`));
