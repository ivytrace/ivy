/**
 * An import worker (S3 upload → DynamoDB writes and product lookups) whose tracer kept the first and slowest
 * calls and the failing one, collapsed the rest into one summary span per signature (`ivy.collapsed.*`) and
 * omitted 37 spans at its span limit. Plain data (offsets in ms from the invocation's start), shared by the
 * `importWorker` trace and the UI's mock. No imports, so the UI's Vite config can load it.
 */

export interface ImportSpanSpec {
  id: string;
  name: string;
  offset: number;
  duration: number;
  attributes: Record<string, string>;
  status?: "OK" | "ERROR" | "UNSET";
  statusMessage?: string;
}

export const IMPORT_DURATION_MS = 9812.4;

export const importRootAttributes: Record<string, string> = {
  "ivy.collapsed_calls": "1496",
  "ivy.dropped_spans": "37",
  "ivy.dropped_spans.reason": "span limit",
  "ivy.payload.request": JSON.stringify({
    Records: [{ eventSource: "aws:s3", s3: { bucket: { name: "acme-imports" }, object: { key: "imports/2026-11-14/orders.csv" } } }],
  }),
  "ivy.payload.response": JSON.stringify({ imported: 1192, failed: 1 }),
};

const log = (offset: number, severity: string, message: string) => ({
  offset,
  name: "log",
  attributes: { "log.severity": severity, "log.message": message },
});

export const importLogs = [
  log(2, "info", "Importing s3://acme-imports/imports/2026-11-14/orders.csv"),
  log(5424, "warn", "Row 611: ProvisionedThroughputExceededException, skipped"),
  log(9805, "info", "Imported 1192 of 1193 orders"),
];

const aws = (service: string, method: string, extra: Record<string, string>, request: unknown, response: unknown, status = "200") => ({
  "rpc.system": "aws-api",
  "rpc.service": service,
  "rpc.method": method,
  "cloud.region": "eu-west-1",
  "aws.request_id": `${service.toUpperCase()}${method.toUpperCase()}REQ`,
  "http.response.status_code": status,
  ...extra,
  "ivy.payload.request": JSON.stringify(request),
  "ivy.payload.response": JSON.stringify(response),
});

const ORDERS = { "aws.dynamodb.table_names": '["orders"]' };
const orderItem = (row: number) => ({ TableName: "orders", Item: { pk: { S: `ORDER#imp_${row}` }, status: { S: "imported" } } });

const putItem = (id: string, offset: number, duration: number, row: number): ImportSpanSpec => ({
  id,
  name: "DynamoDB.PutItem",
  offset,
  duration,
  attributes: aws("DynamoDB", "PutItem", ORDERS, orderItem(row), {}),
});

const productLookup = (id: string, offset: number, duration: number, sku: string): ImportSpanSpec => ({
  id,
  name: "GET api.example.com",
  offset,
  duration,
  attributes: {
    "http.request.method": "GET",
    "url.full": `https://api.example.com/products/${sku}`,
    "server.address": "api.example.com",
    "server.port": "443",
    "http.route": "/products/{sku}",
    "http.response.status_code": "200",
    "ivy.payload.response": JSON.stringify({ sku, price: 1999 }),
  },
});

const THROUGHPUT = "The level of configured provisioned throughput for the table was exceeded";

export const importSpans: ImportSpanSpec[] = [
  {
    id: "i2",
    name: "S3.GetObject",
    offset: 12,
    duration: 184.2,
    attributes: aws(
      "S3",
      "GetObject",
      { "aws.s3.bucket": "acme-imports", "aws.s3.key": "imports/2026-11-14/orders.csv" },
      { Bucket: "acme-imports", Key: "imports/2026-11-14/orders.csv" },
      { ContentLength: 2481930, ContentType: "text/csv" },
    ),
  },
  putItem("p1", 205, 5.8, 1),
  productLookup("h1", 208, 38.1, "SKU-1001"),
  putItem("p2", 212, 4.9, 2),
  putItem("p3", 219, 6.1, 3),
  putItem("p4", 226, 5.2, 4),
  productLookup("h2", 230, 41.3, "SKU-1002"),
  putItem("p5", 233, 4.7, 5),
  {
    id: "s1",
    name: "DynamoDB.PutItem × 1,184",
    offset: 240,
    duration: 9060,
    attributes: {
      "rpc.system": "aws-api",
      "rpc.service": "DynamoDB",
      "rpc.method": "PutItem",
      "cloud.region": "eu-west-1",
      ...ORDERS,
      "ivy.collapsed.count": "1184",
      "ivy.collapsed.duration_total_ms": "6130.4",
      "ivy.collapsed.duration_max_ms": "29.8",
      "ivy.collapsed.duration_min_ms": "2.1",
      "ivy.collapsed.errors": "1",
      "ivy.collapsed.kept": "9",
      "ivy.collapsed.signature": "DynamoDB.PutItem orders",
    },
  },
  productLookup("h3", 252, 36.4, "SKU-1003"),
  {
    id: "s2",
    name: "GET api.example.com × 312",
    offset: 275,
    duration: 8990,
    attributes: {
      "http.request.method": "GET",
      "server.address": "api.example.com",
      "server.port": "443",
      "http.route": "/products/{sku}",
      "http.response.status_code": "200",
      "ivy.collapsed.count": "312",
      "ivy.collapsed.duration_total_ms": "11420.7",
      "ivy.collapsed.duration_max_ms": "88.2",
      "ivy.collapsed.duration_min_ms": "21.4",
      "ivy.collapsed.errors": "0",
      "ivy.collapsed.kept": "4",
      "ivy.collapsed.signature": "GET api.example.com /products/{sku}",
    },
  },
  putItem("p6", 3120, 48.2, 402),
  productLookup("h4", 4870, 212.6, "SKU-1187"),
  {
    id: "p7",
    name: "DynamoDB.PutItem",
    offset: 5402,
    duration: 22.4,
    status: "ERROR",
    statusMessage: `ProvisionedThroughputExceededException: ${THROUGHPUT}`,
    attributes: aws(
      "DynamoDB",
      "PutItem",
      ORDERS,
      orderItem(611),
      { __type: "com.amazonaws.dynamodb.v20120810#ProvisionedThroughputExceededException", message: THROUGHPUT },
      "400",
    ),
  },
  putItem("p8", 6870, 41.0, 880),
  putItem("p9", 8410, 38.7, 1105),
];
