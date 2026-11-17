// A queue consumer that runs each job in a worker thread (so a cancelled job can be stopped with
// process.exit() without taking the runtime down). The worker loads this same file.
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const target = process.env.ECHO_URL || 'http://host.docker.internal:4398';
const clock = () => performance.timeOrigin + performance.now();

async function runJob({ id, cancel }) {
  console.log(`job ${id} running in a worker thread`);
  const res = await fetch(`${target}/echo?job=${id}`);
  await res.text();
  const dynamo = new DynamoDBClient({ endpoint: `${target}/dynamodb`, maxAttempts: 1 });
  await dynamo.send(new GetItemCommand({ TableName: 'jobs', Key: { id: { S: id } } }));
  if (cancel) process.exit(130);
}

if (!isMainThread) {
  const started = clock();
  await runJob(workerData);
  parentPort.postMessage({ started, finished: clock() });
}

export const handler = async (event) => {
  const results = [];
  for (const record of event.Records ?? []) {
    const job = JSON.parse(record.body);
    const t0 = clock();
    const worker = new Worker(new URL(import.meta.url), { workerData: job });
    let timing;
    worker.on('message', (m) => (timing = m));
    const code = await new Promise((resolve, reject) => {
      worker.on('exit', resolve);
      worker.on('error', reject);
    });
    const end = clock();
    results.push({ id: job.id, code, startupMs: timing && timing.started - t0, totalMs: end - t0, exitMs: timing && end - timing.finished });
  }
  return { results };
};
