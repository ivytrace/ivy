/** OTLP request builders for tests. */
/** Length-delimited protobuf field. */
const ld = (num: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([(num << 3) | 2, body.length]), body]);
};
const span = (name: string) => ld(2, ld(1, Buffer.alloc(16, 1)), Buffer.from([0x28, 0x02]), ld(5, Buffer.from(name)));
const resource = ld(1, ld(1, ld(1, Buffer.from('service.name'))));

export function protobufRequest(spansPerScope: number[][]): Buffer {
  return Buffer.concat(
    spansPerScope.map((scopes) => ld(1, resource, ...scopes.map((n) => ld(2, ld(1, ld(1, Buffer.from('s'))), ...Array.from({ length: n }, (_, i) => span(`s${i}`)))))),
  );
}

export function jsonRequest(n: number) {
  return { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: 's' }, spans: Array.from({ length: n }, () => ({ name: 'x' })) }] }] };
}
