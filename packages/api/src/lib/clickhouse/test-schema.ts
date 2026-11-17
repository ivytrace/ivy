import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function statements(): string[] {
  const sql = readFileSync(join(import.meta.dirname, '../../../../../deploy/clickhouse/schema.sql'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replaceAll('{{RETENTION_DAYS}}', '3650');
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const QUERY_SURFACE = /\bivy_query\b/;
const SPAN_TABLE = /\bivy\.(otel_traces|invocations\w*|function_throttles)\b/g;

/**
 * For `*.clickhouse.test.ts`: the span-data part of deploy/clickhouse/schema.sql (materialized views included),
 * pointed at a throwaway database.
 */
export function schemaStatements(db: string): string[] {
  return statements()
    .filter((s) => !/ROW POLICY|ivy_control|CREATE DATABASE/.test(s) && !QUERY_SURFACE.test(s) && /\bivy\./.test(s))
    .map((s) => s.replace(SPAN_TABLE, `${db}.$1`));
}

/**
 * The Query page's part of schema.sql (views, role, row policies, profile, quota) for the throwaway database:
 * the database, role, profile and quota are all named `<db>_query`.
 */
export function queryStatements(db: string): string[] {
  return statements()
    .filter((s) => QUERY_SURFACE.test(s) && !/ivy_control/.test(s))
    .map((s) => s.replace(/\bivy_query\b/g, `${db}_query`).replace(SPAN_TABLE, `${db}.$1`));
}
