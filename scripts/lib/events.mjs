import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ROOT } from './paths.mjs';

export const EVENTS_DIR = join(ROOT, 'contracts', 'events');

export function loadCatalogue() {
  return parse(readFileSync(join(EVENTS_DIR, 'topics.yaml'), 'utf8'));
}

/** Every topic that must exist in Kafka: event topics + dead-letter topics. */
export function allTopicNames(catalogue = loadCatalogue()) {
  return [...catalogue.topics.map((t) => t.name), ...catalogue.deadLetters.topics];
}
