import { maybeFail, type FunctionDef } from '../trace/generate.js';
import { InvocationError, sourceIp, USER_AGENTS } from '../trace/invocation.js';
import { chance, hex, latency, pick, randomInt, shortId, uuid } from '../trace/random.js';

const ACCOUNT = '123456789012';
const EU = 'eu-west-1';
const US = 'us-east-1';

const PRODUCTS = [
  { sku: 'TEE-ORG-M', name: 'Organic tee (M)', price: 2900 },
  { sku: 'HOOD-GRY-L', name: 'Grey hoodie (L)', price: 6900 },
  { sku: 'MUG-CER-01', name: 'Ceramic mug', price: 1500 },
  { sku: 'CAP-BLK', name: 'Black cap', price: 2400 },
  { sku: 'SOCK-3PK', name: 'Socks (3-pack)', price: 1200 },
];
const EMAILS = ['ana@example.com', 'bram@example.org', 'chen@example.net', 'dana@example.com', 'eli@example.io'];

function apiGatewayV2Event(method: string, path: string, route: string, body?: unknown, extraHeaders = {}) {
  const now = Date.now();
  return {
    version: '2.0',
    routeKey: `${method} ${route}`,
    rawPath: path,
    rawQueryString: '',
    headers: {
      accept: 'application/json',
      authorization: '[redacted]',
      'content-type': 'application/json',
      host: 'api.shop.example.com',
      'user-agent': pick(USER_AGENTS),
      'x-forwarded-for': sourceIp(),
      ...extraHeaders,
    },
    requestContext: {
      accountId: ACCOUNT,
      apiId: 'k3x9q2m1ab',
      domainName: 'api.shop.example.com',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: sourceIp(), userAgent: pick(USER_AGENTS) },
      requestId: `${hex(8)}=`,
      routeKey: `${method} ${route}`,
      stage: '$default',
      timeEpoch: now,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function orderId() {
  return `ord_${hex(12)}`;
}

const createOrder: FunctionDef = {
  name: 'checkout-api-prod-createOrder',
  region: EU,
  accountId: ACCOUNT,
  memoryMb: 512,
  weight: 14,
  timeoutS: 10,
  faasTrigger: 'http',
  triggerSource: 'aws:apigatewayv2',
  kind: 'SERVER',
  memoryUsedMb: [92, 118],
  event() {
    const items = Array.from({ length: randomInt(1, 4) }, () => ({ ...pick(PRODUCTS), quantity: randomInt(1, 3) }));
    const body = { customerId: shortId('cus'), items, currency: 'EUR', paymentMethod: 'pm_card_visa', password: '[redacted]' };
    return {
      event: apiGatewayV2Event('POST', '/orders', '/orders', body, { 'idempotency-key': uuid() }),
      http: { method: 'POST', path: '/orders', route: '/orders' },
    };
  },
  run(ctx, event) {
    const { inv } = ctx;
    const body = JSON.parse((event as { body: string }).body);
    const total = body.items.reduce((sum: number, i: { price: number; quantity: number }) => sum + i.price * i.quantity, 0);
    inv.log('info', `Creating order for ${body.customerId} (${body.items.length} items, €${(total / 100).toFixed(2)})`);
    inv.aws('DynamoDB', 'GetItem', {
      ms: latency(ctx.coldStart ? 45 : 7, 0.4),
      attributes: { 'aws.dynamodb.table_names': ['customers-prod'] },
      request: { TableName: 'customers-prod', Key: { pk: { S: `CUSTOMER#${body.customerId}` } } },
      response: {
        Item: {
          pk: { S: `CUSTOMER#${body.customerId}` },
          email: { S: pick(EMAILS) },
          stripeCustomerId: { S: shortId('cus') },
          tier: { S: pick(['standard', 'standard', 'plus']) },
        },
      },
    });
    if (chance(0.01)) {
      throw new InvocationError('ValidationError', `Invalid quantity for SKU ${pick(PRODUCTS).sku}: must be between 1 and ${randomInt(5, 20)}`);
    }

    const stripeFails = chance(0.035 + ctx.errorBoost);
    const declined = !stripeFails && chance(0.04);
    const piId = shortId('pi', 24);
    inv.http('POST', 'https://api.stripe.com/v1/payment_intents', {
      ms: stripeFails ? latency(2800, 0.3) : latency(260, 0.35),
      status: stripeFails ? 502 : declined ? 402 : 200,
      requestHeaders: { authorization: '[redacted]', 'idempotency-key': uuid() },
      responseHeaders: { 'request-id': shortId('req'), 'stripe-version': '2025-10-29' },
      request: { amount: total, currency: 'eur', customer: shortId('cus'), payment_method: 'pm_card_visa', confirm: true },
      response: stripeFails
        ? '<html><body><h1>502 Bad Gateway</h1></body></html>'
        : declined
          ? { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } }
          : { id: piId, object: 'payment_intent', amount: total, currency: 'eur', status: 'succeeded', client_secret: '[redacted]' },
    });
    if (stripeFails) throw new InvocationError('StripeAPIError', 'Unexpected response from Stripe: 502 Bad Gateway');
    if (declined) {
      inv.log('warn', `Payment declined for ${body.customerId}: insufficient_funds`);
      return { response: jsonResponse(402, { error: 'payment_declined', reason: 'insufficient_funds' }), httpStatus: 402 };
    }

    const id = orderId();
    inv.aws('DynamoDB', 'PutItem', {
      ms: latency(9, 0.4),
      attributes: { 'aws.dynamodb.table_names': ['orders-prod'] },
      request: {
        TableName: 'orders-prod',
        Item: { pk: { S: `ORDER#${id}` }, customerId: { S: body.customerId }, total: { N: String(total) }, status: { S: 'paid' } },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
      response: { ConsumedCapacity: { TableName: 'orders-prod', CapacityUnits: 1 } },
    });
    const messageId = uuid();
    inv.aws('SQS', 'SendMessage', {
      ms: latency(14, 0.35),
      attributes: {
        'messaging.system': 'aws_sqs',
        'messaging.destination.name': 'order-events-prod',
        'messaging.message.id': messageId,
      },
      request: {
        QueueUrl: `https://sqs.${EU}.amazonaws.com/${ACCOUNT}/order-events-prod`,
        MessageBody: JSON.stringify({ type: 'order.created', orderId: id, total }),
      },
      response: { MessageId: messageId, MD5OfMessageBody: hex(32) },
    });
    inv.log('info', `Order ${id} created`);
    return { response: jsonResponse(201, { id, status: 'paid', total, currency: 'EUR' }), httpStatus: 201 };
  },
};

const getOrder: FunctionDef = {
  name: 'checkout-api-prod-getOrder',
  region: EU,
  accountId: ACCOUNT,
  memoryMb: 256,
  weight: 32,
  timeoutS: 6,
  faasTrigger: 'http',
  triggerSource: 'aws:apigatewayv2',
  kind: 'SERVER',
  memoryUsedMb: [71, 84],
  event() {
    const id = orderId();
    return {
      event: apiGatewayV2Event('GET', `/orders/${id}`, '/orders/{id}'),
      http: { method: 'GET', path: `/orders/${id}`, route: '/orders/{id}' },
    };
  },
  run(ctx, event) {
    const { inv } = ctx;
    const id = (event as { rawPath: string }).rawPath.split('/').pop()!;
    const missing = chance(0.06);
    inv.aws('DynamoDB', 'GetItem', {
      ms: latency(ctx.coldStart ? 40 : 6, 0.45),
      attributes: { 'aws.dynamodb.table_names': ['orders-prod'] },
      request: { TableName: 'orders-prod', Key: { pk: { S: `ORDER#${id}` } } },
      response: missing
        ? {}
        : {
            Item: {
              pk: { S: `ORDER#${id}` },
              status: { S: pick(['paid', 'shipped', 'delivered']) },
              total: { N: String(randomInt(1200, 25000)) },
              items: { L: [{ M: { sku: { S: pick(PRODUCTS).sku }, quantity: { N: '1' } } }] },
            },
          },
    });
    if (missing) {
      inv.log('info', `Order ${id} not found`);
      return { response: jsonResponse(404, { error: 'not_found' }), httpStatus: 404 };
    }
    maybeFail(ctx, 0.03, 'TypeError', "Cannot read properties of undefined (reading 'items')");
    return { response: jsonResponse(200, { id, status: 'shipped' }), httpStatus: 200 };
  },
};

const processOrder: FunctionDef = {
  name: 'orders-worker-prod-processOrder',
  region: EU,
  accountId: ACCOUNT,
  memoryMb: 1024,
  weight: 14,
  timeoutS: 30,
  faasTrigger: 'pubsub',
  triggerSource: 'aws:sqs',
  kind: 'CONSUMER',
  memoryUsedMb: [140, 210],
  event() {
    const id = orderId();
    return {
      event: {
        Records: [
          {
            messageId: uuid(),
            receiptHandle: '[redacted]',
            body: JSON.stringify({ type: 'order.created', orderId: id, total: randomInt(1200, 25000) }),
            attributes: { ApproximateReceiveCount: String(chance(0.05) ? 2 : 1), SentTimestamp: String(Date.now()) },
            eventSource: 'aws:sqs',
            eventSourceARN: `arn:aws:sqs:${EU}:${ACCOUNT}:order-events-prod`,
            awsRegion: EU,
          },
        ],
      },
    };
  },
  run(ctx, event) {
    const { inv } = ctx;
    const record = (event as { Records: Array<{ body: string }> }).Records[0];
    const { orderId: id } = JSON.parse(record.body);
    inv.log('info', `Processing ${id}`);

    if (chance(0.008)) {
      inv.work(latency(400, 0.3));
      throw new InvocationError('Timeout', 'Task timed out after 30.00 seconds', undefined, 30_000);
    }
    const conflict = chance(0.045 + ctx.errorBoost);
    inv.aws('DynamoDB', 'UpdateItem', {
      ms: latency(11, 0.4),
      attributes: { 'aws.dynamodb.table_names': ['orders-prod'] },
      request: {
        TableName: 'orders-prod',
        Key: { pk: { S: `ORDER#${id}` } },
        UpdateExpression: 'SET #s = :s, updatedAt = :now',
        ConditionExpression: '#s = :paid',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': { S: 'fulfilling' }, ':paid': { S: 'paid' }, ':now': { N: String(Date.now()) } },
      },
      response: { Attributes: { status: { S: 'fulfilling' } } },
      error: conflict
        ? { type: 'ConditionalCheckFailedException', message: 'The conditional request failed', statusCode: 400 }
        : undefined,
    });
    if (conflict) throw new InvocationError('ConditionalCheckFailedException', 'The conditional request failed');

    inv.work(latency(25, 0.5));
    const pdfBytes = randomInt(38_000, 120_000);
    inv.aws('S3', 'PutObject', {
      ms: latency(48, 0.4),
      attributes: { 'aws.s3.bucket': 'invoices-prod', 'aws.s3.key': `2026/${id}.pdf` },
      request: { Bucket: 'invoices-prod', Key: `2026/${id}.pdf`, ContentType: 'application/pdf', ContentLength: pdfBytes },
      response: { ETag: `"${hex(32)}"`, ServerSideEncryption: 'AES256' },
    });
    const messageId = uuid();
    inv.aws('SNS', 'Publish', {
      ms: latency(18, 0.4),
      attributes: {
        'messaging.system': 'aws_sns',
        'messaging.destination.name': 'order-fulfilled-prod',
        'messaging.message.id': messageId,
      },
      request: {
        TopicArn: `arn:aws:sns:${EU}:${ACCOUNT}:order-fulfilled-prod`,
        Message: JSON.stringify({ orderId: id, invoice: `s3://invoices-prod/2026/${id}.pdf` }),
      },
      response: { MessageId: messageId },
    });
    inv.log('info', `Order ${id} fulfilled`);
    return { response: { batchItemFailures: [] } };
  },
};

const resizeImage: FunctionDef = {
  name: 'media-prod-resizeImage',
  region: EU,
  accountId: ACCOUNT,
  memoryMb: 2048,
  weight: 6,
  timeoutS: 60,
  faasTrigger: 'datasource',
  triggerSource: 'aws:s3',
  kind: 'CONSUMER',
  memoryUsedMb: [480, 910],
  event() {
    const key = `uploads/${uuid()}.${pick(['jpg', 'jpg', 'png', 'heic'])}`;
    return {
      event: {
        Records: [
          {
            eventVersion: '2.1',
            eventSource: 'aws:s3',
            awsRegion: EU,
            eventTime: new Date().toISOString(),
            eventName: 'ObjectCreated:Put',
            s3: { bucket: { name: 'media-uploads-prod' }, object: { key, size: randomInt(400_000, 6_000_000) } },
          },
        ],
      },
    };
  },
  run(ctx, event) {
    const { inv } = ctx;
    const key: string = (event as { Records: Array<{ s3: { object: { key: string; size: number } } }> }).Records[0].s3.object.key;
    inv.aws('S3', 'GetObject', {
      ms: latency(120, 0.5),
      attributes: { 'aws.s3.bucket': 'media-uploads-prod', 'aws.s3.key': key },
      request: { Bucket: 'media-uploads-prod', Key: key },
      response: { ContentType: key.endsWith('png') ? 'image/png' : 'image/jpeg', ContentLength: randomInt(400_000, 6_000_000), Body: '[binary]' },
    });
    if (key.endsWith('heic') && chance(0.4)) {
      throw new InvocationError('Error', 'Input buffer contains unsupported image format');
    }
    inv.work(latency(380, 0.4));
    const sizes = [160, 640, 1280];
    inv.parallel(
      sizes.map((size) => () => {
        const out = key.replace('uploads/', `thumbs/${size}/`).replace(/\.\w+$/, '.webp');
        inv.aws('S3', 'PutObject', {
          ms: latency(60 + size / 20, 0.4),
          attributes: { 'aws.s3.bucket': 'media-public-prod', 'aws.s3.key': out },
          request: { Bucket: 'media-public-prod', Key: out, ContentType: 'image/webp', CacheControl: 'max-age=31536000' },
          response: { ETag: `"${hex(32)}"` },
        });
      }),
    );
    inv.log('info', `Resized ${key} to ${sizes.join(', ')}px`);
    return { response: { ok: true, variants: sizes.length } };
  },
};

const dailyDigest: FunctionDef = {
  name: 'reports-prod-dailyDigest',
  region: EU,
  accountId: ACCOUNT,
  memoryMb: 1024,
  weight: 1.5,
  timeoutS: 15,
  faasTrigger: 'timer',
  triggerSource: 'aws:scheduled',
  kind: 'INTERNAL',
  memoryUsedMb: [210, 380],
  event() {
    return {
      event: {
        version: '0',
        id: uuid(),
        'detail-type': 'Scheduled Event',
        source: 'aws.events',
        account: ACCOUNT,
        time: new Date().toISOString(),
        region: EU,
        resources: [`arn:aws:events:${EU}:${ACCOUNT}:rule/reports-prod-digest`],
        detail: {},
      },
    };
  },
  run(ctx) {
    const { inv } = ctx;
    const pages = randomInt(2, 6);
    const rows: unknown[] = [];
    for (let page = 0; page < pages; page++) {
      const items = Array.from({ length: 40 }, () => ({
        pk: { S: `ORDER#${orderId()}` },
        total: { N: String(randomInt(1200, 25000)) },
        email: { S: pick(EMAILS) },
      }));
      rows.push(...items);
      inv.aws('DynamoDB', 'Query', {
        ms: latency(65, 0.4),
        attributes: { 'aws.dynamodb.table_names': ['orders-prod'] },
        request: {
          TableName: 'orders-prod',
          IndexName: 'byDay',
          KeyConditionExpression: 'gsi1pk = :day',
          ExpressionAttributeValues: { ':day': { S: `DAY#${new Date(inv.startMs).toISOString().slice(0, 10)}` } },
          ...(page > 0 ? { ExclusiveStartKey: { pk: { S: `ORDER#${orderId()}` } } } : {}),
        },
        response: { Count: items.length, ScannedCount: items.length, Items: items },
      });
    }
    inv.log('info', `Aggregated ${rows.length} orders over ${pages} pages`);
    if (chance(0.05)) {
      inv.log('warn', 'Report rendering is slow, approaching timeout');
      throw new InvocationError('Timeout', 'Task timed out after 15.00 seconds', undefined, 15_000);
    }
    inv.work(latency(900, 0.5));
    const report = { generatedAt: new Date(inv.cursorMs).toISOString(), rows };
    inv.aws('S3', 'PutObject', {
      ms: latency(140, 0.4),
      attributes: { 'aws.s3.bucket': 'reports-prod', 'aws.s3.key': `digest/${new Date(inv.startMs).toISOString().slice(0, 10)}.json` },
      request: { Bucket: 'reports-prod', Key: 'digest.json', Body: report },
      response: { ETag: `"${hex(32)}"` },
    });
    inv.aws('SES', 'SendEmail', {
      ms: latency(85, 0.35),
      request: {
        Source: 'reports@shop.example.com',
        Destination: { ToAddresses: ['ops@shop.example.com'] },
        Message: { Subject: { Data: 'Daily digest' }, Body: { Text: { Data: `${rows.length} orders today` } } },
      },
      response: { MessageId: `${hex(16)}-${uuid()}-000000` },
    });
    return { response: { orders: rows.length } };
  },
};

let cachedSecret = false;

const login: FunctionDef = {
  name: 'auth-api-prod-login',
  region: US,
  accountId: ACCOUNT,
  memoryMb: 512,
  weight: 14,
  timeoutS: 10,
  faasTrigger: 'http',
  triggerSource: 'aws:function-url',
  kind: 'SERVER',
  memoryUsedMb: [96, 130],
  event() {
    const body = { email: pick(EMAILS), password: '[redacted]', remember: chance(0.5) };
    return {
      event: {
        version: '2.0',
        rawPath: '/login',
        headers: { 'content-type': 'application/json', 'user-agent': pick(USER_AGENTS), cookie: '[redacted]' },
        requestContext: {
          domainName: `${hex(32)}.lambda-url.${US}.on.aws`,
          http: { method: 'POST', path: '/login', sourceIp: sourceIp() },
          requestId: uuid(),
        },
        body: JSON.stringify(body),
      },
      http: { method: 'POST', path: '/login', route: '/login' },
    };
  },
  run(ctx, event) {
    const { inv } = ctx;
    if (ctx.coldStart || !cachedSecret) {
      cachedSecret = true;
      inv.aws('SecretsManager', 'GetSecretValue', {
        ms: latency(55, 0.3),
        request: { SecretId: 'auth/prod/jwt-signing-key' },
        response: { ARN: `arn:aws:secretsmanager:${US}:${ACCOUNT}:secret:auth/prod/jwt-signing-key-${hex(6)}`, Name: 'auth/prod/jwt-signing-key', SecretString: '[redacted]' },
      });
    }
    const { email } = JSON.parse((event as { body: string }).body);
    inv.aws('DynamoDB', 'GetItem', {
      ms: latency(8, 0.4),
      attributes: { 'aws.dynamodb.table_names': ['users-prod'] },
      request: { TableName: 'users-prod', Key: { email: { S: email } } },
      response: { Item: { email: { S: email }, userId: { S: shortId('usr') }, passwordHash: { S: '[redacted]' } } },
    });
    inv.work(latency(95, 0.15));
    if (chance(0.12)) {
      inv.log('warn', `Invalid credentials for ${email}`);
      return { response: jsonResponse(401, { error: 'invalid_credentials' }), httpStatus: 401 };
    }
    maybeFail(ctx, 0.03, 'JsonWebTokenError', 'invalid signature');
    inv.aws('DynamoDB', 'PutItem', {
      ms: latency(9, 0.4),
      attributes: { 'aws.dynamodb.table_names': ['sessions-prod'] },
      request: { TableName: 'sessions-prod', Item: { sessionId: { S: uuid() }, email: { S: email }, ttl: { N: String(Math.floor(Date.now() / 1000) + 86400) } } },
      response: {},
    });
    return { response: jsonResponse(200, { token: '[redacted]', expiresIn: 3600 }), httpStatus: 200 };
  },
};

const sendPush: FunctionDef = {
  name: 'notifications-prod-sendPush',
  region: EU,
  accountId: ACCOUNT,
  memoryMb: 256,
  weight: 11,
  timeoutS: 10,
  faasTrigger: 'pubsub',
  triggerSource: 'aws:sns',
  kind: 'CONSUMER',
  memoryUsedMb: [64, 79],
  event() {
    return {
      event: {
        Records: [
          {
            EventSource: 'aws:sns',
            Sns: {
              MessageId: uuid(),
              TopicArn: `arn:aws:sns:${EU}:${ACCOUNT}:order-fulfilled-prod`,
              Message: JSON.stringify({ orderId: orderId(), userId: shortId('usr') }),
              Timestamp: new Date().toISOString(),
            },
          },
        ],
      },
    };
  },
  run(ctx) {
    const { inv } = ctx;
    inv.aws('DynamoDB', 'Query', {
      ms: latency(9, 0.4),
      attributes: { 'aws.dynamodb.table_names': ['device-tokens-prod'] },
      request: { TableName: 'device-tokens-prod', KeyConditionExpression: 'userId = :u', ExpressionAttributeValues: { ':u': { S: shortId('usr') } } },
      response: { Count: 1, Items: [{ token: { S: '[redacted]' }, platform: { S: pick(['ios', 'android']) } }] },
    });
    const timeout = chance(0.04);
    const stale = !timeout && chance(0.05);
    inv.http('POST', 'https://fcm.googleapis.com/v1/projects/shop-prod/messages:send', {
      ms: timeout ? latency(5000, 0.05) : latency(120, 0.4),
      status: timeout ? 504 : stale ? 404 : 200,
      requestHeaders: { authorization: '[redacted]' },
      request: { message: { token: '[redacted]', notification: { title: 'Your order has shipped', body: 'Track it in the app' } } },
      response: timeout
        ? undefined
        : stale
          ? { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }
          : { name: `projects/shop-prod/messages/${hex(16)}` },
    });
    if (timeout) {
      throw new InvocationError(
        'FetchError',
        'request to https://fcm.googleapis.com/v1/projects/shop-prod/messages:send failed, reason: ETIMEDOUT',
      );
    }
    if (stale) {
      inv.log('info', 'Device token is stale, removing');
      inv.aws('DynamoDB', 'DeleteItem', {
        ms: latency(8, 0.4),
        attributes: { 'aws.dynamodb.table_names': ['device-tokens-prod'] },
        request: { TableName: 'device-tokens-prod', Key: { token: { S: '[redacted]' } } },
        response: {},
      });
    }
    return { response: { delivered: !stale } };
  },
};

export const FUNCTIONS: FunctionDef[] = [getOrder, createOrder, processOrder, login, sendPush, resizeImage, dailyDigest];

/** The function that gets an error spike during the simulated incident window. */
export const INCIDENT_FUNCTION = processOrder.name;
