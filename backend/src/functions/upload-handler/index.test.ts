/**
 * Unit tests for upload-handler Lambda function
 */

// @ts-nocheck
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { handler } from './index';
import { UploadStatus } from '@shared/types';

// Mock AWS clients
const dynamoMock = mockClient(DynamoDBDocumentClient);
const cloudWatchMock = mockClient(CloudWatchClient);

// Mock S3 presigned URL generation
jest.mock('@shared/aws-clients', () => ({
  ...jest.requireActual('@shared/aws-clients'),
  awsClients: {
    generatePresignedUrl: jest.fn().mockResolvedValue('https://test-presigned-url.com'),
    publishMetric: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('Upload Handler Lambda', () => {
  const mockContext: Context = {
    awsRequestId: 'test-request-id',
    functionName: 'upload-handler',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789:function:upload-handler',
    memoryLimitInMB: '512',
    getRemainingTimeInMillis: () => 30000,
    callbackWaitsForEmptyEventLoop: false,
    logGroupName: '/aws/lambda/upload-handler',
    logStreamName: '2024/01/01/test-stream',
    succeed: jest.fn(),
    fail: jest.fn(),
    done: jest.fn(),
  };

  beforeEach(() => {
    dynamoMock.reset();
    cloudWatchMock.reset();
    
    // Set required environment variables
    process.env.UPLOAD_BUCKET = 'test-bucket';
    process.env.UPLOAD_TABLE = 'test-table';
    process.env.NODE_ENV = 'test';
  });

  describe('POST /upload', () => {
    const validUploadRequest = {
      fileName: 'test-song.mp3',
      fileSize: 5000000, // 5MB
      contentType: 'audio/mpeg',
      metadata: {
        title: 'Test Song',
        artist: 'Test Artist',
        album: 'Test Album',
        genre: 'Rock',
        year: 2023,
      },
      userId: 'user123',
    };

    const createEvent = (body: any): APIGatewayProxyEvent => ({
      httpMethod: 'POST',
      path: '/upload',
      pathParameters: null,
      queryStringParameters: null,
      headers: { 'Content-Type': 'application/json' },
      multiValueHeaders: {},
      multiValueQueryStringParameters: null,
      body: JSON.stringify(body),
      isBase64Encoded: false,
      stageVariables: null,
      requestContext: {
        requestId: 'test-request',
        stage: 'test',
        httpMethod: 'POST',
        path: '/upload',
        protocol: 'HTTP/1.1',
        requestTime: '01/Jan/2024:00:00:00 +0000',
        requestTimeEpoch: Date.now(),
        resourcePath: '/upload',
        resourceId: 'resource',
        accountId: '123456789',
        apiId: 'test-api',
        identity: {
          sourceIp: '127.0.0.1',
          userAgent: 'test-agent',
          clientCert: null,
          accessKey: null,
          accountId: null,
          apiKey: null,
          apiKeyId: null,
          caller: null,
          cognitoAuthenticationProvider: null,
          cognitoAuthenticationType: null,
          cognitoIdentityId: null,
          cognitoIdentityPoolId: null,
          principalOrgId: null,
          user: null,
          userArn: null,
        },
        authorizer: null,
      },
      resource: '/upload',
    });

    it('should successfully initiate upload with valid request', async () => {
      dynamoMock.on(PutCommand).resolves({});

      const event = createEvent(validUploadRequest);
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(201);
      
      const body = JSON.parse(result.body);
      expect(body.uploadId).toBeDefined();
      expect(body.presignedUrl).toBe('https://test-presigned-url.com');
      expect(body.expiresIn).toBe(3600);
      expect(body.maxFileSize).toBeDefined();

      // Verify DynamoDB call
      expect(dynamoMock.commandCalls(PutCommand)).toHaveLength(1);
      const putCall = dynamoMock.commandCalls(PutCommand)[0];
      expect(putCall.args[0].input.Item).toMatchObject({
        userId: 'user123',
        fileName: 'test-song.mp3',
        status: UploadStatus.PENDING,
      });
    });

    it('should reject invalid file type', async () => {
      const invalidRequest = {
        ...validUploadRequest,
        fileName: 'test-document.pdf',
        contentType: 'application/pdf',
      };

      const event = createEvent(invalidRequest);
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(400);
      
      const body = JSON.parse(result.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain('Unsupported file type');
    });

    it('should reject file that is too large', async () => {
      const largeFileRequest = {
        ...validUploadRequest,
        fileSize: 250 * 1024 * 1024, // 250MB
      };

      const event = createEvent(largeFileRequest);
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(400);
      
      const body = JSON.parse(result.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain('File too large');
    });

    it('should reject invalid metadata', async () => {
      const invalidMetadataRequest = {
        ...validUploadRequest,
        metadata: {
          title: '', // Empty title should fail
          artist: 'Test Artist',
        },
      };

      const event = createEvent(invalidMetadataRequest);
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(400);
      
      const body = JSON.parse(result.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain('Title is required');
    });

    it('should handle DynamoDB errors gracefully', async () => {
      dynamoMock.on(PutCommand).rejects(new Error('DynamoDB unavailable'));

      const event = createEvent(validUploadRequest);
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(500);
      
      const body = JSON.parse(result.body);
      expect(body.error.code).toBe('DYNAMODB_ERROR');
      expect(body.error.retryable).toBe(true);
    });

    it('should enforce rate limits', async () => {
      // Mock query to return high count
      dynamoMock.on(QueryCommand).resolves({ Count: 60 });

      const event = createEvent(validUploadRequest);
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(429);
      
      const body = JSON.parse(result.body);
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(body.error.message).toContain('Rate limit exceeded');
    });
  });

  describe('GET /upload/{id}', () => {
    const createGetEvent = (uploadId: string, userId: string): APIGatewayProxyEvent => ({
      httpMethod: 'GET',
      path: `/upload/${uploadId}`,
      pathParameters: { id: uploadId },
      queryStringParameters: { userId },
      headers: {},
      multiValueHeaders: {},
      multiValueQueryStringParameters: null,
      body: null,
      isBase64Encoded: false,
      stageVariables: null,
      requestContext: {
        requestId: 'test-request',
        stage: 'test',
        httpMethod: 'GET',
        path: `/upload/${uploadId}`,
        protocol: 'HTTP/1.1',
        requestTime: '01/Jan/2024:00:00:00 +0000',
        requestTimeEpoch: Date.now(),
        resourcePath: '/upload/{id}',
        resourceId: 'resource',
        accountId: '123456789',
        apiId: 'test-api',
        identity: {
          sourceIp: '127.0.0.1',
          userAgent: 'test-agent',
          clientCert: null,
          accessKey: null,
          accountId: null,
          apiKey: null,
          apiKeyId: null,
          caller: null,
          cognitoAuthenticationProvider: null,
          cognitoAuthenticationType: null,
          cognitoIdentityId: null,
          cognitoIdentityPoolId: null,
          principalOrgId: null,
          user: null,
          userArn: null,
        },
        authorizer: null,
      },
      resource: '/upload/{id}',
    });

    it('should return upload status successfully', async () => {
      const testUploadId = '123e4567-e89b-12d3-a456-426614174000';
      const mockUpload = {
        uploadId: testUploadId,
        userId: 'user123',
        fileName: 'test-song.mp3',
        status: UploadStatus.COMPLETED,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      dynamoMock.on(GetCommand).resolves({ Item: mockUpload });

      const event = createGetEvent(testUploadId, 'user123');
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(200);
      
      const body = JSON.parse(result.body);
      expect(body.uploadId).toBe(testUploadId);
      expect(body.status).toBe(UploadStatus.COMPLETED);
      expect(body.ttl).toBeUndefined(); // TTL should be filtered out
    });

    it('should return 404 for non-existent upload', async () => {
      dynamoMock.on(GetCommand).resolves({ Item: undefined });

      const testUploadId = '123e4567-e89b-12d3-a456-426614174001';
      const event = createGetEvent(testUploadId, 'user123');
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(404);
      
      const body = JSON.parse(result.body);
      expect(body.error.code).toBe('UPLOAD_NOT_FOUND');
    });

    it('should validate upload ID format', async () => {
      const event = createGetEvent('invalid-uuid', 'user123');
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(400);
      
      const body = JSON.parse(result.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain('Invalid upload ID format');
    });
  });

  describe('DELETE /upload/{id}', () => {
    const createDeleteEvent = (uploadId: string, body: any): APIGatewayProxyEvent => ({
      httpMethod: 'DELETE',
      path: `/upload/${uploadId}`,
      pathParameters: { id: uploadId },
      queryStringParameters: null,
      headers: { 'Content-Type': 'application/json' },
      multiValueHeaders: {},
      multiValueQueryStringParameters: null,
      body: JSON.stringify(body),
      isBase64Encoded: false,
      stageVariables: null,
      requestContext: {
        requestId: 'test-request',
        stage: 'test',
        httpMethod: 'DELETE',
        path: `/upload/${uploadId}`,
        protocol: 'HTTP/1.1',
        requestTime: '01/Jan/2024:00:00:00 +0000',
        requestTimeEpoch: Date.now(),
        resourcePath: '/upload/{id}',
        resourceId: 'resource',
        accountId: '123456789',
        apiId: 'test-api',
        identity: {
          sourceIp: '127.0.0.1',
          userAgent: 'test-agent',
          clientCert: null,
          accessKey: null,
          accountId: null,
          apiKey: null,
          apiKeyId: null,
          caller: null,
          cognitoAuthenticationProvider: null,
          cognitoAuthenticationType: null,
          cognitoIdentityId: null,
          cognitoIdentityPoolId: null,
          principalOrgId: null,
          user: null,
          userArn: null,
        },
        authorizer: null,
      },
      resource: '/upload/{id}',
    });

    it('should successfully cancel upload', async () => {
      const testUploadId = '123e4567-e89b-12d3-a456-426614174002';
      dynamoMock.on(UpdateCommand).resolves({
        Attributes: {
          uploadId: testUploadId,
          status: UploadStatus.FAILED,
        },
      });

      const event = createDeleteEvent(testUploadId, {
        userId: 'user123',
        reason: 'User cancelled',
      });
      
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(200);
      
      const body = JSON.parse(result.body);
      expect(body.message).toContain('cancelled successfully');
      expect(body.status).toBe(UploadStatus.FAILED);
    });

    it('should return 404 for non-cancellable upload', async () => {
      const testUploadId = '123e4567-e89b-12d3-a456-426614174003';
      dynamoMock.on(UpdateCommand).rejects({
        name: 'ConditionalCheckFailedException',
        message: 'The conditional request failed',
      });

      const event = createDeleteEvent(testUploadId, {
        userId: 'user123',
        reason: 'User cancelled',
      });
      
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(404);
      
      const body = JSON.parse(result.body);
      expect(body.error.code).toBe('UPLOAD_NOT_FOUND');
    });
  });

  describe('Error handling', () => {
    it('should return 405 for unsupported method', async () => {
      const event = createEvent({});
      event.httpMethod = 'PATCH';
      
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(405);
      
      const body = JSON.parse(result.body);
      expect(body.error.message).toContain('Method PATCH not allowed');
    });

    it('should handle malformed JSON', async () => {
      const event = createEvent({});
      event.body = 'invalid-json{';
      
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(400);
      
      const body = JSON.parse(result.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should include request ID in error responses', async () => {
      const event = createEvent({});
      event.httpMethod = 'PATCH';
      
      const result = await handler(event, mockContext) as any;

      const body = JSON.parse(result.body);
      expect(body.requestId).toBe('test-request-id');
    });
  });

  const createEvent = (body: any): APIGatewayProxyEvent => ({
    httpMethod: 'POST',
    path: '/upload',
    pathParameters: null,
    queryStringParameters: null,
    headers: { 'Content-Type': 'application/json' },
    multiValueHeaders: {},
    body: JSON.stringify(body),
    isBase64Encoded: false,
    stageVariables: null,
    requestContext: {
      requestId: 'test-request',
      stage: 'test',
      httpMethod: 'POST',
      path: '/upload',
      protocol: 'HTTP/1.1',
      requestTime: '01/Jan/2024:00:00:00 +0000',
      requestTimeEpoch: Date.now(),
      resourcePath: '/upload',
      resourceId: 'resource',
      accountId: '123456789',
      apiId: 'test-api',
      identity: {
        sourceIp: '127.0.0.1',
        userAgent: 'test-agent',
        clientCert: null,
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        user: null,
        userArn: null,
      },
      authorizer: null,
    },
    resource: '/upload',
  });
});