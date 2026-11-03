// Run once by npm test (node --test-global-setup) around all the test files. Every test
// database of this run is named pos_test_<run>_..., so the teardown can drop what a test
// file left behind if it crashed before its own clean-up (test/support/harness.js).
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { TEST_MONGODB_URI, refuseProduction, dropDatabases } from './databases.js';

export async function globalSetup() {
  refuseProduction();
  // The test files run in child processes, which inherit this
  process.env.POS_TEST_RUN = randomBytes(4).toString('hex');
}

export async function globalTeardown() {
  const run = process.env.POS_TEST_RUN;
  if (!run) return;
  let conn;
  try {
    conn = await mongoose.createConnection(TEST_MONGODB_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
    const left = await dropDatabases(conn, `pos_test_${run}_`);
    if (left.length) console.log(`Dropped test databases left behind: ${left.join(', ')}`);
  } catch (err) {
    // MongoDB is not reachable, so the tests failed too: say so instead of failing again
    console.error(`Could not check for leftover test databases: ${err.message}`);
  } finally {
    await conn?.close();
  }
}
