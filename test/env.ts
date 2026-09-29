// Loaded in every test worker before any test file: point every service at the isolated test resources.
process.env.NODE_ENV = 'test';
process.env.PG_DATABASE = process.env.PG_TEST_DATABASE ?? 'anchorpay_test';
process.env.REDIS_KEY_PREFIX = process.env.TEST_REDIS_KEY_PREFIX ?? 'aptest:';
process.env.BCRYPT_ROUNDS = '4'; // fast hashing in tests only; production default is 12
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.MESSAGING_LOG_FILE = process.env.MESSAGING_LOG_FILE ?? 'logs/test-mailbox.log';

// Load the root .env (secrets such as INTERNAL_SERVICE_TOKEN) after the overrides above; it never overrides them.
const { loadEnv } = await import('../packages/service-kit/src/env.ts');
loadEnv();

export {};
