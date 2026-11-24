# @ivytrace/lambda-web

Traces Node.js [Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html) with
[Ivy](https://ivytrace.dev): every HTTP request your server handles becomes an invocation in Ivy, with its AWS SDK,
HTTP and fetch calls, logs, LLM calls and errors. No code changes beyond installing the package.

Web Functions don't support Lambda layers, so instead of the Ivy layer the tracer ships in your deployment package
and Node.js loads it before your app.

## Setup

```sh
npm install @ivytrace/lambda-web
```

Add these environment variables to your Web Function revision:

| variable | value |
|---|---|
| `NODE_OPTIONS` | `--import @ivytrace/lambda-web` |
| `IVY_ENDPOINT` | your Ivy ingest URL |
| `IVY_API_KEY` | your project's ingest key |

Revisions don't inherit settings, so include your existing variables when you create the next revision.

Any server built on `node:http` works: Express, Hono's Node.js server, Fastify, plain `http.createServer`.

## How requests show up

- The request ID is Lambda's `lambda-web-request-id` header, so you can find a request in Ivy by the ID a client
  received.
- The function name comes from `AWS_LAMBDA_FUNCTION_NAME` when Lambda sets it, else `IVY_FUNCTION_NAME`, else the
  endpoint name (`lambda-web-endpoint-name`).
- The request (method, URL, headers, body) and response (status, headers, body) are recorded with the same
  redaction rules and size limits as the Ivy layer. A status of 500 or above marks the invocation as failed.
- Spans are exported from the process shortly after each request finishes, and on `SIGTERM` when Lambda shuts the
  environment down. If your app calls `process.exit()` right away on `SIGTERM`, requests from the last ~100 ms
  before shutdown may be lost.

All `IVY_*` settings of the Ivy layer that apply to the tracer (payload limits, redaction, log capture, …) work
the same way; see the layer's README.
