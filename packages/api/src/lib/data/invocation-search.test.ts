import { describe, expect, it } from 'vitest';
import { attributeTraceIds, parseInvocationSearch } from './invocation-search.js';

describe('parseInvocationSearch', () => {
  it('keeps plain free text as is', () => {
    expect(parseInvocationSearch('connection refused')).toEqual({ text: 'connection refused', attributes: [] });
    expect(parseInvocationSearch(undefined)).toEqual({ text: '', attributes: [] });
    expect(parseInvocationSearch('  ')).toEqual({ text: '', attributes: [] });
  });

  it('extracts key=value terms', () => {
    expect(parseInvocationSearch('job.id=abc123')).toEqual({ text: '', attributes: [{ key: 'job.id', value: 'abc123' }] });
    expect(parseInvocationSearch('job.task=import timeout job.attempt=3')).toEqual({
      text: 'timeout',
      attributes: [
        { key: 'job.task', value: 'import' },
        { key: 'job.attempt', value: '3' },
      ],
    });
  });

  it('reads quoted values, with escaped quotes', () => {
    expect(parseInvocationSearch('job.reason="manual retry" failed')).toEqual({
      text: 'failed',
      attributes: [{ key: 'job.reason', value: 'manual retry' }],
    });
    expect(parseInvocationSearch('note="say \\"hi\\""').attributes).toEqual([{ key: 'note', value: 'say "hi"' }]);
  });

  it('keeps = inside values', () => {
    expect(parseInvocationSearch('cursor=eyJ0Ijo1fQ==').attributes).toEqual([{ key: 'cursor', value: 'eyJ0Ijo1fQ==' }]);
  });

  it('leaves text that is not a term alone', () => {
    expect(parseInvocationSearch('=abc')).toEqual({ text: '=abc', attributes: [] });
    expect(parseInvocationSearch('job.id=')).toEqual({ text: 'job.id=', attributes: [] });
    expect(parseInvocationSearch('job.id=""')).toEqual({ text: 'job.id=""', attributes: [] });
    expect(parseInvocationSearch('/orders/1=2').attributes).toEqual([]);
  });

  it('caps the number of terms', () => {
    const q = Array.from({ length: 11 }, (_, i) => `k${i}=v`).join(' ');
    expect(() => parseInvocationSearch(q)).toThrow(/Too many/);
  });
});

describe('attributeTraceIds', () => {
  it('binds keys and values, and scopes to tenant, project and time', () => {
    const { sql, params } = attributeTraceIds([{ key: 'job.id', value: "abc'123" }], 'AND ProjectId = {project:String}');
    expect(params).toEqual({ attr_key_0: 'job.id', attr_value_0: "abc'123" });
    expect(sql).not.toContain("abc'123");
    expect(sql).toMatch(/^SELECT DISTINCT TraceId FROM otel_traces/);
    expect(sql).toContain('TenantId = {tenant:String} AND ProjectId = {project:String}');
    expect(sql).toContain('Timestamp >= fromUnixTimestamp64Milli({from:Int64} - 60000)');
    expect(sql).toContain('Timestamp < fromUnixTimestamp64Milli({to:Int64} + 900000)');
    expect(sql).toContain('SpanAttributes[{attr_key_0:String}] = {attr_value_0:String}');
    expect(sql).not.toContain('GROUP BY');
  });

  it('requires every term to match some span of the trace', () => {
    const { sql, params } = attributeTraceIds(
      [
        { key: 'job.id', value: 'a' },
        { key: 'job.task', value: 'import' },
      ],
      '',
    );
    expect(Object.keys(params)).toEqual(['attr_key_0', 'attr_value_0', 'attr_key_1', 'attr_value_1']);
    expect(sql).toContain('(SpanAttributes[{attr_key_0:String}] = {attr_value_0:String} OR SpanAttributes[{attr_key_1:String}] = {attr_value_1:String})');
    expect(sql).toContain(
      'GROUP BY TraceId HAVING max(SpanAttributes[{attr_key_0:String}] = {attr_value_0:String}) AND max(SpanAttributes[{attr_key_1:String}] = {attr_value_1:String})',
    );
  });
});
