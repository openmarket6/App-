/**
 * Point the application's own config at the test database before any src/
 * module is imported. config/env.ts validates on import, so this has to run
 * first -- hence setupFiles rather than a beforeAll.
 */
process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'fatal';
process.env['DATABASE_URL'] = process.env['TEST_APP_DATABASE_URL'] ?? '';
process.env['DATABASE_SERVICE_URL'] = process.env['TEST_SERVICE_DATABASE_URL'] ?? '';

/*
 * A fixed webhook secret so signature verification can be tested for real.
 *
 * Set here rather than in the test because config/env.ts validates and freezes
 * on import, so anything assigned after the first `src/` import is not seen.
 *
 * LOB_API_KEY is deliberately NOT set: mail stays unconfigured, so no test can
 * accidentally reach a provider, while the signature path is still exercised.
 */
process.env['LOB_WEBHOOK_SECRET'] = 'test-lob-webhook-secret';
