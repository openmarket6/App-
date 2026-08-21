/**
 * Structured logging.
 *
 * The redaction list is the important part. Logs get shipped to third parties,
 * pasted into tickets and read by people who should not see a bearer token, so
 * the safe default is that secrets never enter the log stream at all rather
 * than relying on nobody looking.
 */
import { pino } from 'pino';
import { env, isProd } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'req.headers["stripe-signature"]',
      'res.headers["set-cookie"]',
      'password',
      '*.password',
      'token',
      '*.token',
      'access_token',
      '*.access_token',
      'refresh_token',
      '*.refresh_token',
      'secret',
      '*.secret',
      'apiKey',
      '*.apiKey',
      'card',
      '*.card',
      'payment_method',
      '*.payment_method',
      'secret_encrypted',
      '*.secret_encrypted',
    ],
    censor: '[redacted]',
  },
  ...(isProd
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
});

export type Logger = typeof logger;
