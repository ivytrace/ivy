// Allocates until the V8 heap limit is reached (run with NODE_OPTIONS=--max-old-space-size=32).
exports.handler = async () => {
  console.log('loading everything into memory');
  const hoard = [];
  for (;;) hoard.push(new Array(100000).fill('x'.repeat(16)));
};
