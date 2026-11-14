// An "import worker": one invocation that makes thousands of similar calls. Used by the e2e test for
// collapsing, chunked export and the payload budget.
//   { "mode": "dynamodb", "items": 3000 }  PutItem per item against the fake DynamoDB endpoint
//   { "mode": "llm", "calls": 300 }         POSTs with ~16 KB bodies to a fake model endpoint
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');

const target = process.env.ECHO_URL || 'http://host.docker.internal:4399';
const dynamo = new DynamoDBClient({ endpoint: `${target}/dynamodb`, maxAttempts: 1 });
const failing = new DynamoDBClient({ endpoint: `${target}/dynamodb-fail`, maxAttempts: 1 });

async function importItems(n) {
  let failed = 0;
  for (let i = 0; i < n; i++) {
    await dynamo.send(new PutItemCommand({ TableName: 'orders', Item: { id: { S: `order-${i}` }, total: { N: String(i) } } }));
    if (i === 100 || i === 2000) {
      try {
        await failing.send(new PutItemCommand({ TableName: 'orders', Item: { id: { S: `bad-${i}` } } }));
      } catch {
        failed++;
      }
    }
  }
  return { imported: n, failed };
}

async function classify(n) {
  const filler = 'lorem ipsum dolor sit amet '.repeat(600).slice(0, 16_000);
  let tokens = 0;
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${target}/llm/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-fake' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: `Classify order ${i}: ${filler}` }] }),
    });
    const body = await res.json();
    tokens += body.usage.prompt_tokens + body.usage.completion_tokens;
  }
  return { classified: n, tokens };
}

exports.handler = async (event) => {
  console.log('import started', event.mode);
  const result = event.mode === 'llm' ? await classify(event.calls ?? 300) : await importItems(event.items ?? 3000);
  console.log('import finished', result);
  return result;
};
