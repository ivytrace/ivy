import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * For `*.clickhouse.test.ts`: the span-data part of deploy/clickhouse/schema.sql (materialized views included),
 * pointed at a throwaway database.
 */
export function schemaStatements(db: string): string[] {
  const sql = readFileSync(join(import.meta.dirname, '../../../../../deploy/clickhouse/schema.sql'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replaceAll('{{RETENTION_DAYS}}', '3650');
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/ROW POLICY|ivy_control|CREATE DATABASE/.test(s) && /\bivy\./.test(s))
    .map((s) => s.replace(/\bivy\.(otel_traces|invocations\w*|function_throttles)\b/g, `${db}.$1`));
}
