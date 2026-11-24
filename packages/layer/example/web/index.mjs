// A Lambda Web Function: its own HTTP server on AWS_LAMBDA_HTTP_ENDPOINT. Used by scripts/e2e-web.mjs.
import { createServer } from 'node:http';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const target = process.env.ECHO_URL || 'http://127.0.0.1:4399';
const dynamo = new DynamoDBClient({ endpoint: `${target}/dynamodb`, region: 'eu-west-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' }, maxAttempts: 1 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const id = url.searchParams.get('id') ?? 'none';
  console.log(`order ${id}`);
  if (url.pathname === '/fail') {
    res.writeHead(500).end('broken');
    return;
  }
  await sleep(Number(url.searchParams.get('wait') ?? 0));
  await dynamo.send(new GetItemCommand({ TableName: 'orders', Key: { id: { S: id } } }));
  await fetch(`${target}/echo?order=${id}`).then((r) => r.text());
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
});

const [host, port] = process.env.AWS_LAMBDA_HTTP_ENDPOINT.split(':');
server.listen(Number(port), host, () => console.log('listening'));
