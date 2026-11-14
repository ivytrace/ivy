import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

const target = process.env.ECHO_URL || 'http://host.docker.internal:4399';
const dynamo = new DynamoDBClient({ endpoint: `${target}/dynamodb-fail`, maxAttempts: 1 });

export const handler = async (event) => {
  console.log('esm handler invoked');
  const res = await fetch(`${target}/echo?from=esm`);
  await res.text();
  try {
    await dynamo.send(new PutItemCommand({ TableName: 'orders', Item: { id: { S: 'o-1' }, secret: { S: 'x' } } }));
  } catch (err) {
    console.error('dynamo failed as expected:', err.name);
  }
  return { ok: true, records: event?.Records?.length ?? 0 };
};
