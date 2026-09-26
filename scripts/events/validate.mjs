// Validates the Kafka contract: topic catalogue <-> schemas <-> examples.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { EVENTS_DIR as DIR, loadCatalogue } from '../lib/events.mjs';

const TOPIC_NAME = /^[a-z]+(\.[a-z]+(-[a-z]+)*)+$/;
const readJson = (...p) => JSON.parse(readFileSync(join(DIR, ...p), 'utf8'));

function main() {
  const catalogue = loadCatalogue();
  const errors = [];
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);

  const schemaFiles = readdirSync(join(DIR, 'schemas')).filter((f) => f.endsWith('.json'));
  for (const f of schemaFiles) ajv.addSchema(readJson('schemas', f));

  const referenced = new Set(['common.schema.json']);
  const names = new Set();

  for (const t of catalogue.topics) {
    if (!TOPIC_NAME.test(t.name)) errors.push(`${t.name}: topic name must be lower-case words joined by dots/hyphens`);
    if (names.has(t.name)) errors.push(`${t.name}: duplicate topic`);
    names.add(t.name);
    for (const field of ['key', 'producer', 'consumers', 'schema', 'description']) {
      if (!t[field] || (Array.isArray(t[field]) && t[field].length === 0)) errors.push(`${t.name}: missing ${field}`);
    }
    const schemaFile = t.schema.replace(/^schemas\//, '');
    referenced.add(schemaFile);
    let schema;
    try {
      schema = readJson('schemas', schemaFile);
    } catch {
      errors.push(`${t.name}: schema file ${t.schema} not found`);
      continue;
    }
    if (schema.properties?.eventType?.const !== t.name) errors.push(`${t.name}: schema eventType const must equal the topic name`);

    const validate = ajv.getSchema(schema.$id);
    let example;
    try {
      example = readJson('examples', `${t.name}.json`);
    } catch {
      errors.push(`${t.name}: example examples/${t.name}.json not found`);
      continue;
    }
    if (!validate(example)) errors.push(`${t.name}: example invalid: ${ajv.errorsText(validate.errors)}`);
    if (example.producer !== t.producer) errors.push(`${t.name}: example producer ${example.producer} != catalogue producer ${t.producer}`);
    if (!example.data[t.key]) errors.push(`${t.name}: message key field "${t.key}" missing from data`);

    // Contracts are closed: unknown fields (e.g. someone adding an email address) must be rejected.
    const tampered = structuredClone(example);
    tampered.data.email = 'someone@example.com';
    if (validate(tampered)) errors.push(`${t.name}: schema accepts unknown data fields (add additionalProperties: false)`);
  }

  const dlqFile = catalogue.deadLetters.schema.replace(/^schemas\//, '');
  referenced.add(dlqFile);
  const dlqValidate = ajv.getSchema(readJson('schemas', dlqFile).$id);
  if (!dlqValidate(readJson('examples', 'dlq.json'))) errors.push(`dlq example invalid: ${ajv.errorsText(dlqValidate.errors)}`);
  for (const d of catalogue.deadLetters.topics) if (!/^dlq\.[a-z-]+-service$/.test(d)) errors.push(`${d}: DLQ must be named dlq.<service>`);

  for (const f of schemaFiles) if (!referenced.has(f)) errors.push(`schemas/${f} is not referenced by topics.yaml`);

  if (errors.length) {
    console.error(`Event contract check FAILED (${errors.length}):\n - ${errors.join('\n - ')}`);
    process.exit(1);
  }
  console.log(`Event contracts OK: ${catalogue.topics.length} topics, ${catalogue.deadLetters.topics.length} dead-letter topics, all examples valid.`);
}

main();
