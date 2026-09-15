// Must be required before any module that reads config/db connection info.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5455/helebooker_test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.CALENDLY_WEBHOOK_SIGNING_KEY = 'test-calendly-signing-key';
