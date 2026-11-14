import { errorTemplateSql } from '@ivy/spans';

/**
 * Error groups are computed at query time over `invocations` (docs/implementation/error-grouping.md), so rows
 * stored before a change to the rules regroup too. The template is the message with its variable parts replaced
 * (`errorTemplate` in @ivy/spans); the fingerprint hashes function, error type, code location and template.
 */
export const ERROR_TEMPLATE_SQL = errorTemplateSql('error_message', 'error_type');

/** Fingerprint over a row that has `error_template` (as an alias of `ERROR_TEMPLATE_SQL`). */
export const ERROR_FINGERPRINT_SQL = 'lower(hex(cityHash64(function, error_type, error_frame, error_template)))';

/** The columns `error_template` and `fingerprint`, to add to a SELECT over `invocations`. */
export const ERROR_GROUP_COLUMNS = `${ERROR_TEMPLATE_SQL} AS error_template, ${ERROR_FINGERPRINT_SQL} AS fingerprint`;

/** The fingerprint as one expression over a plain `invocations` row (for WHERE). */
export const ERROR_FINGERPRINT_EXPR = ERROR_FINGERPRINT_SQL.replace('error_template', () => ERROR_TEMPLATE_SQL);
