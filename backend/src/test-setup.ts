/**
 * Jest test setup file
 * Configures global test environment and mocks
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.AWS_REGION = 'us-east-1';
process.env.UPLOAD_BUCKET = 'test-bucket';
process.env.UPLOAD_TABLE = 'test-table';
process.env.SQS_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue';
process.env.LOG_LEVEL = 'error'; // Reduce log noise in tests