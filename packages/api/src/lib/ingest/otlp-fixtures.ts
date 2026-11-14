/** OTLP request builders for tests. */
/** Length-delimited protobuf field. */
const ld = (num: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const len: number[] = [];
  let n = body.length;
  while (n > 0x7f) {
    len.push((n & 0x7f) | 0x80);
    n >>= 7;
  }
  len.push(n);
  return Buffer.concat([Buffer.from([(num << 3) | 2, ...len]), body]);
};
const span = (name: string, ...attributes: Buffer[]) =>
  ld(2, ld(1, Buffer.alloc(16, 1)), Buffer.from([0x28, 0x02]), ld(5, Buffer.from(name)), ...attributes);
/** KeyValue attribute (span field 9) with a string (AnyValue 1) or bool (AnyValue 2, varint) value. */
const attr = (key: string, value: string | boolean) =>
  ld(9, ld(1, Buffer.from(key)), ld(2, typeof value === 'string' ? ld(1, Buffer.from(value)) : Buffer.from([0x10, value ? 1 : 0])));
const resource = ld(1, ld(1, ld(1, Buffer.from('service.name'))));

export function protobufRequest(spansPerScope: number[][]): Buffer {
  return Buffer.concat(
    spansPerScope.map((scopes) => ld(1, resource, ...scopes.map((n) => ld(2, ld(1, ld(1, Buffer.from('s'))), ...Array.from({ length: n }, (_, i) => span(`s${i}`)))))),
  );
}

export function jsonRequest(n: number) {
  return { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: 's' }, spans: Array.from({ length: n }, () => ({ name: 'x' })) }] }] };
}

/** One scope with `invocations` root spans marked `ivy.invocation` (alternating bool/string) and `others` plain spans. */
export function protobufInvocations(invocations: number, others = 0): Buffer {
  const spans = [
    ...Array.from({ length: invocations }, (_, i) => span(`inv${i}`, attr('faas.trigger', 'http'), attr('ivy.invocation', i % 2 ? 'true' : true))),
    ...Array.from({ length: others }, (_, i) => span(`child${i}`, attr('ivy.invocation', false))),
  ];
  return ld(1, resource, ld(2, ld(1, ld(1, Buffer.from('s'))), ...spans));
}

export function jsonInvocations(invocations: number, others = 0) {
  const spans = [
    ...Array.from({ length: invocations }, () => ({ name: 'inv', attributes: [{ key: 'ivy.invocation', value: { boolValue: true } }] })),
    ...Array.from({ length: others }, () => ({ name: 'child', attributes: [{ key: 'http.method', value: { stringValue: 'GET' } }] })),
  ];
  return { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: 's' }, spans }] }] };
}
