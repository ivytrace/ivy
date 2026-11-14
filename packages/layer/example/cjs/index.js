const http = require('node:http');
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');

const target = process.env.ECHO_URL || 'http://host.docker.internal:4399';
const dynamo = new DynamoDBClient({ endpoint: `${target}/dynamodb`, maxAttempts: 1 });

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

exports.handler = async (event) => {
  console.log('cjs handler invoked', { keys: Object.keys(event || {}) });
  if (event && event.sleepMs) await new Promise((r) => setTimeout(r, event.sleepMs));
  if (event && event.fail) throw new Error('Intentional failure');

  const res = await fetch(`${target}/echo?api_key=supersecret&page=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer hunter2' },
    body: JSON.stringify({ hello: 'world', password: 'hunter2' }),
  });
  const echoed = await res.json();
  const viaHttp = await httpGet(`${target}/echo?via=http`);
  const item = await dynamo.send(new GetItemCommand({ TableName: 'users', Key: { id: { S: '42' } } }));
  console.warn('done');
  return { statusCode: 200, body: JSON.stringify({ echoed, viaHttp: viaHttp.status, item: item.Item }) };
};

exports.callbackHandler = (event, context, callback) => {
  console.info('callback handler invoked');
  httpGet(`${target}/echo?style=callback`).then(
    (r) => callback(null, { ok: true, status: r.status }),
    (err) => callback(err),
  );
};
