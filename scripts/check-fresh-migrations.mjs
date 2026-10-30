import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
const require = createRequire(`${root}/package.json`);
const { Client } = createRequire(require.resolve('@prisma/adapter-pg'))('pg');
const source = process.env.DATABASE_MIGRATION_TEST_URL;
assert(source, 'Set DATABASE_MIGRATION_TEST_URL to a local PostgreSQL database.');
const url = new URL(source);
assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '5433', 'Migration tests require local PostgreSQL on port 5433.');
const name = `magica_migrations_${randomUUID().replaceAll('-', '')}`;
const admin = new Client({ connectionString: source });
await admin.connect();
let created = false;
let client;
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  url.pathname = `/${name}`;
  const env = { ...process.env, NODE_ENV: 'production', DATABASE_URL: url.href, DIRECT_URL: url.href, DATABASE_URL_UNPOOLED: url.href };
  for (const pass of ['fresh install', 'repeat deploy']) {
    const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replaceAll(url.href, '<local test database>');
    assert.equal(result.status, 0, `${pass} failed:\n${output}`);
    console.log(`${pass}: passed`);
  }
  client = new Client({ connectionString: url.href });
  await client.connect();
  const foreignKeys = (await client.query(`SELECT conname, confkey, convalidated FROM pg_constraint WHERE conname IN ('UploadBatch_chatId_userId_fkey', 'MessageAttachment_chatId_userId_fkey', 'AgentRun_chatId_userId_fkey')`)).rows;
  assert.equal(foreignKeys.length, 3);
  assert(foreignKeys.every(row => row.convalidated && row.confkey.length === 2));
  const indexes = (await client.query(`SELECT indexname FROM pg_indexes WHERE tablename='Chat' AND indexname IN ('Chat_id_userId_key', 'Chat_upload_owner_key')`)).rows;
  assert.deepEqual(indexes, [{ indexname: 'Chat_id_userId_key' }]);
  console.log('Ownership foreign keys validated; no temporary duplicate index remains.');
} finally {
  await client?.end();
  if (created) await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
}
