/**
 * Test vectors for `errorTemplate`, shared by its unit test and the ClickHouse test that runs the same rules
 * in SQL (packages/api/src/lib/data/error-groups.clickhouse.test.ts): [error type, message, template].
 */
export const TEMPLATE_VECTORS: ReadonlyArray<readonly [type: string, message: string, template: string]> = [
  // Production: one bug, many messages.
  ["Error", "Upload not found for ID: fonts/mono-regular.woff", "Upload not found for ID: {path}"],
  ["Error", "Upload not found for ID: favicon.ico", "Upload not found for ID: {path}"],
  ["Error", "Upload not found for ID: _code-highlighting.js", "Upload not found for ID: {path}"],
  ["Error", "Upload not found for ID: fonts/semibold.woff2", "Upload not found for ID: {path}"],
  ["Error", "Upload not found for ID: _mermaid.js", "Upload not found for ID: {path}"],
  ["Error", "Upload not found for ID: 3f1c9a2e-7b44-4c1d-9e0a-5b6c7d8e9f01", "Upload not found for ID: {id}"],
  ["Error", "Upload not found for ID: report", "Upload not found for ID: {id}"],

  // IDs.
  ["Error", "Order 9f8e7d6c-5b4a-4321-8fed-cba987654321 not found", "Order {id} not found"],
  ["Error", "Session 507f1f77bcf86cd799439011 expired", "Session {id} expired"],
  ["Error", "Unknown tenant ten_8f2k1x", "Unknown tenant {id}"],
  ["Error", "User usr_123 has no workspace", "User {id} has no workspace"],
  ["Error", "Lookup failed for userId=a81bc81b", "Lookup failed for userId={id}"],
  ["Error", "Lookup failed for userId=alice", "Lookup failed for userId={id}"],
  ["Error", "Missing object, key: invoices-acme", "Missing object, key: {id}"],
  ["Error", "Item with id=42 is locked", "Item with id={num} is locked"],

  // Stripe.
  ["StripeInvalidRequestError", "No such customer: 'cus_NffrFeUfNV2Hib'", "No such customer: '{id}'"],
  ["StripeInvalidRequestError", "No such payment_intent: 'pi_3MtwBwLkdIwHu7ix28a3tqPa'", "No such payment_intent: '{id}'"],
  ["StripeCardError", "Your card was declined.", "Your card was declined."],
  ["StripeInvalidRequestError", "Amount must be at least 50 cents", "Amount must be at least {num} cents"],

  // AWS.
  [
    "AccessDeniedException",
    "User: arn:aws:sts::123456789012:assumed-role/checkout-role/checkout-createOrder is not authorized to perform: dynamodb:PutItem on resource: arn:aws:dynamodb:eu-west-1:123456789012:table/orders",
    "User: {id} is not authorized to perform: dynamodb:PutItem on resource: {id}",
  ],
  ["ResourceNotFoundException", "Requested resource not found: Table: orders-prod not found", "Requested resource not found: Table: orders-prod not found"],
  ["NoSuchKey", "The specified key does not exist.", "The specified key does not exist."],
  ["ValidationException", "Item size has exceeded the maximum allowed size of 400 KB", "Item size has exceeded the maximum allowed size of {num} KB"],
  ["InvalidParameterValue", "Message too long: 300000 bytes", "Message too long: {num} bytes"],
  ["InvalidInstanceID.NotFound", "The instance ID 'i-0abcd1234ef567890' does not exist", "The instance ID 'i-{id}' does not exist"],
  ["Error", "connect ECONNREFUSED 10.0.1.25:5432", "connect ECONNREFUSED {ip}"],
  ["Error", "getaddrinfo ENOTFOUND api.example.com", "getaddrinfo ENOTFOUND api.example.com"],

  // Numbers, but not inside words.
  ["Sandbox.Timedout", "Task timed out after 3.00 seconds", "Task timed out after {num} seconds"],
  ["SyntaxError", "Unexpected token < in JSON at position 0", "Unexpected token < in JSON at position {num}"],
  ["Error", "Request failed with status code 503", "Request failed with status code {num}"],
  ["Error", "Retry -1 of 3 after 500ms", "Retry -{num} of {num} after {num}ms"],
  ["Error", "s3 v2 client: utf8 decode failed", "s3 v2 client: utf8 decode failed"],
  ["Error", "Unsupported encoding utf-8", "Unsupported encoding utf-8"],
  ["Error", "Expected version 1.2.3", "Expected version {num}"],

  // Emails, URLs, dates.
  ["Error", "Duplicate entry 'bob@example.com' for key 'users.email'", "Duplicate entry '{email}' for key 'users.email'"],
  ["Error", "Could not deliver to alice.smith+tag@mail.example.com", "Could not deliver to {email}"],
  ["Error", "GET https://api.example.com/v1/orders/123?expand=items failed", "GET {url} failed"],
  ["Error", "Cannot reach s3://acme-uploads/2026/11/report.pdf", "Cannot reach {url}"],
  ["Error", "Token expired at 2026-11-14T10:00:00.000Z", "Token expired at {date}"],
  ["Error", "No rates for 2026-11-14", "No rates for {date}"],

  // Paths.
  ["Error", "ENOENT: no such file or directory, open '/tmp/abc123/data.json'", "ENOENT: no such file or directory, open '{path}'"],
  ["Error", "Route GET /api/users/123 not found", "Route GET {path} not found"],
  ["Error", "Cannot load ./lib/render.mjs", "Cannot load {path}"],
  ["Error", "Expected content type application/json, got text/html", "Expected content type application/json, got text/html"],
  ["Error", "Node.js version mismatch", "Node.js version mismatch"],
  ["Error", "read and/or write failed", "read and/or write failed"],

  // Quoted text: phrases go, short single words stay.
  ["TypeError", "Cannot read properties of undefined (reading 'id')", "Cannot read properties of undefined (reading 'id')"],
  ["TypeError", "Cannot read properties of undefined (reading 'map')", "Cannot read properties of undefined (reading 'map')"],
  ["Error", "Invalid status 'archived'", "Invalid status 'archived'"],
  ["Error", "Unknown product \"Blue T-shirt, size M\"", "Unknown product {str}"],
  ["Error", "Unknown product \"Red Hoodie\"", "Unknown product {str}"],
  ["Error", "Template `Hello {{name}} and welcome` failed", "Template {str} failed"],
  ["Error", "Bad token 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'", "Bad token {str}"],
  ["Error", "Can't find user's file", "Can't find user's file"],
  ["SyntaxError", "Unexpected token 'u', \"undefined\" is not valid JSON", "Unexpected token 'u', \"undefined\" is not valid JSON"],

  // Kept verbatim: the message names the missing module or handler.
  ["Runtime.ImportModuleError", "Error: Cannot find module 'left-pad'", "Error: Cannot find module 'left-pad'"],
  ["Runtime.ImportModuleError", "Error: Cannot find module '@acme/utils/dist/index.js'", "Error: Cannot find module '@acme/utils/dist/index.js'"],
  ["Runtime.HandlerNotFound", "index.handler2 is undefined or not exported", "index.handler2 is undefined or not exported"],

  // Only the first line, trimmed.
  ["Error", "  Validation failed: 3 errors\n  - name is required\n  - email is invalid", "Validation failed: {num} errors"],
  ["Error", "", ""],
];
