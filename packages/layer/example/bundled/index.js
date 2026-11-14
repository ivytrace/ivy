// Bundled with esbuild by the e2e script, so the SDK is inlined and cannot be patched via require.
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const target = process.env.ECHO_URL || 'http://host.docker.internal:4399';
const dynamo = new DynamoDBClient({ endpoint: `${target}/dynamodb`, maxAttempts: 1 });

export const handler = async () => {
  const item = await dynamo.send(new GetItemCommand({ TableName: 'bundled-table', Key: { id: { S: '1' } } }));
  return { ok: true, name: item.Item?.name?.S };
};
