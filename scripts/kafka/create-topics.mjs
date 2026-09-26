// Creates every topic from contracts/events/topics.yaml that doesn't exist yet (safe to re-run).
// Topics are never deleted by this script: deleting topics can crash Kafka on Windows.
import { createRequire } from 'node:module';
import { env } from '../lib/env.mjs';
import { allTopicNames, loadCatalogue } from '../lib/events.mjs';

const require = createRequire(import.meta.url);
const { Kafka, logLevel } = require('@confluentinc/kafka-javascript').KafkaJS;

export async function withAdmin(fn) {
  const kafka = new Kafka({ kafkaJS: { brokers: env('KAFKA_BROKERS').split(','), clientId: 'anchorpay-tools', logLevel: logLevel.ERROR } });
  const admin = kafka.admin();
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.disconnect();
  }
}

async function main() {
  const catalogue = loadCatalogue();
  const wanted = allTopicNames(catalogue);
  const partitions = Number(env('KAFKA_TOPIC_PARTITIONS', String(catalogue.defaults.partitions)));
  const replicationFactor = Number(env('KAFKA_TOPIC_REPLICATION', String(catalogue.defaults.replicationFactor)));

  await withAdmin(async (admin) => {
    const existing = new Set(await admin.listTopics());
    const missing = wanted.filter((t) => !existing.has(t));
    if (missing.length === 0) {
      console.log(`All ${wanted.length} topics already exist.`);
      return;
    }
    await admin.createTopics({
      topics: missing.map((topic) => ({ topic, numPartitions: partitions, replicationFactor })),
    });
    console.log(`Created ${missing.length} topics (${partitions} partitions, replication ${replicationFactor}):`);
    for (const t of missing) console.log(`  + ${t}`);
  });
}

main().catch((err) => {
  console.error(`Topic creation failed: ${err.message}`);
  process.exit(1);
});
