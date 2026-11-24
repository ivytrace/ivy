import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CreatedKey } from "@/lib/api/types";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="mr-2 size-4" /> : <Copy className="mr-2 size-4" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

function WebFunctionSetup({ env }: { env: string }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer hover:text-foreground">Lambda Web Function?</summary>
      <div className="mt-2 grid gap-2">
        <p>
          Web Functions don't support layers. Install <span className="font-mono">@ivytrace/lambda-web</span> in your app (
          <span className="font-mono">npm install @ivytrace/lambda-web</span>) and set these environment variables on each revision:
        </p>
        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-muted/40 px-2 py-1 font-mono text-xs text-foreground">{env}</pre>
          <CopyButton text={env} />
        </div>
      </div>
    </details>
  );
}

/** A newly created ingest key, shown once, with the environment variables to use it. */
export function KeyReveal({ created, lambda }: { created: CreatedKey; lambda?: boolean }) {
  const endpoint = created.endpoint ?? "<your ingest URL>";
  const env = `${lambda ? "AWS_LAMBDA_EXEC_WRAPPER=/opt/ivy-wrapper\n" : ""}IVY_ENDPOINT=${endpoint}\nIVY_API_KEY=${created.key}`;
  return (
    <div className="grid gap-2 rounded-md border border-emerald-400/30 bg-emerald-400/5 p-3">
      <div className="text-sm font-medium">Copy this key now. Ivy only stores a hash, so it won't be shown again.</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-xs">{created.key}</code>
        <CopyButton text={created.key} />
      </div>
      <div className="text-xs text-muted-foreground">
        {lambda
          ? "Add the Ivy layer to your Lambda function and set these environment variables:"
          : "Environment of the Ivy layer, or any OTLP/HTTP exporter (Authorization: Bearer <key>):"}
      </div>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-muted/40 px-2 py-1 font-mono text-xs">{env}</pre>
        <CopyButton text={env} />
      </div>
      {lambda && <WebFunctionSetup env={`NODE_OPTIONS=--import @ivytrace/lambda-web\nIVY_ENDPOINT=${endpoint}\nIVY_API_KEY=${created.key}`} />}
      {lambda && (
        <p className="text-xs text-muted-foreground">
          Not on Lambda? Any OpenTelemetry SDK or Collector can send OTLP/HTTP to <span className="font-mono">{endpoint}/v1/traces</span> with{" "}
          <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>.
        </p>
      )}
    </div>
  );
}
