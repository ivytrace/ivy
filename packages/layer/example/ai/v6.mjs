// AI SDK 6 with `experimental_telemetry`. Bundled by the e2e script, @opentelemetry/api included.
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import * as ai from 'ai-v6';
import { MockLanguageModelV3 } from 'ai-v6/test';
import { answerCustomer, supportModels } from './scenario.mjs';

const target = process.env.ECHO_URL || 'http://host.docker.internal:4399';
const dynamo = new DynamoDBClient({ endpoint: `${target}/dynamodb`, maxAttempts: 1 });

export const handler = async () =>
  answerCustomer({
    ai,
    models: supportModels({ Mock: MockLanguageModelV3, simulateReadableStream: ai.simulateReadableStream }),
    telemetry: { experimental_telemetry: { isEnabled: true, functionId: 'support-reply' } },
    lookupOrder: async (orderId) => (await dynamo.send(new GetItemCommand({ TableName: 'orders', Key: { id: { S: orderId } } }))).Item,
  });
