const EXPECTED_DATABASE_URL = 'postgresql://storyme:storyme_e2e@127.0.0.1:5440/storyme_e2e';
const EXPECTED_REDIS_URL = 'redis://127.0.0.1:6380/15';

if (process.env['DATABASE_URL'] !== EXPECTED_DATABASE_URL) {
  throw new Error('Integration tests refused a non-disposable DATABASE_URL.');
}
if (process.env['REDIS_URL'] !== EXPECTED_REDIS_URL) {
  throw new Error('Integration tests refused a non-disposable REDIS_URL.');
}
if (process.env['RUN_PAID_AI_EVALS'] === 'true') {
  throw new Error('Paid AI evaluations are forbidden in the integration suite.');
}
