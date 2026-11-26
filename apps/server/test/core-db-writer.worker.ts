// Worker of core-db.test.ts: back-to-back write transactions that each hold the lock a while, like a derive step.
import { parentPort, workerData } from 'node:worker_threads';
import { openDb, run, tx } from '../src/db/db';

const { file, batches, holdMs } = workerData as { file: string; batches: number; holdMs: number };
const db = openDb(file);
parentPort!.postMessage({ type: 'started' });
const t0 = Date.now();
for (let i = 0; i < batches; i++) {
  tx(db, () => {
    run(db, 'INSERT INTO writes (who, at) VALUES (?, ?)', ['worker', Date.now()]);
    const until = Date.now() + holdMs;
    while (Date.now() < until) {
      /* CPU work inside the transaction */
    }
  });
}
db.close();
parentPort!.postMessage({ type: 'done', ms: Date.now() - t0 });
