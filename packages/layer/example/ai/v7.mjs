// AI SDK 7 with @ai-sdk/otel. Bundled by the e2e script with @opentelemetry/api left in node_modules.
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { OpenTelemetry } from '@ai-sdk/otel';
import * as ai from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { answerCustomer, supportModels } from './scenario.mjs';

ai.registerTelemetry(new OpenTelemetry());

const target = process.env.ECHO_URL || 'http://host.docker.internal:4399';
const dynamo = new DynamoDBClient({ endpoint: `${target}/dynamodb`, maxAttempts: 1 });

export const handler = async () =>
  answerCustomer({
    ai,
    models: supportModels({ Mock: MockLanguageModelV4, simulateReadableStream: ai.simulateReadableStream }),
    telemetry: { telemetry: { functionId: 'support-reply' } },
    lookupOrder: async (orderId) => (await dynamo.send(new GetItemCommand({ TableName: 'orders', Key: { id: { S: orderId } } }))).Item,
  });
