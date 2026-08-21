/**
 * Point the application's own config at the test database before any src/
 * module is imported. config/env.ts validates on import, so this has to run
 * first -- hence setupFiles rather than a beforeAll.
 */
process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'fatal';
process.env['DATABASE_URL'] = process.env['TEST_APP_DATABASE_URL'] ?? '';
process.env['DATABASE_SERVICE_URL'] = process.env['TEST_SERVICE_DATABASE_URL'] ?? '';
