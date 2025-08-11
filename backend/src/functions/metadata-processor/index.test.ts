/**
 * Unit tests for metadata-processor Lambda function
 */

import { S3Event, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { 
  S3Client, 
  GetObjectCommand, 
  PutObjectCommand 
} from '@aws-sdk/client-s3';
import { 
  DynamoDBDocumentClient, 
  UpdateCommand 
} from '@aws-sdk/lib-dynamodb';
import { 
  SQSClient, 
  SendMessageCommand 
} from '@aws-sdk/client-sqs';
import { 
  CloudWatchClient, 
  PutMetricDataCommand 
} from '@aws-sdk/client-cloudwatch';
import { Readable } from 'stream';
import { handler } from './index';
import { UploadStatus } from '@shared/types';

// Mock music-metadata
jest.mock('music-metadata', () => ({
  parseFile: jest.fn(),
}));

const { parseFile } = require('music-metadata');

// Mock AWS clients
const s3Mock = mockClient(S3Client);
const dynamoMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);
const cloudWatchMock = mockClient(CloudWatchClient);

describe('Metadata Processor Lambda', () => {
  const mockContext: Context = {
    awsRequestId: 'test-request-id',
    functionName: 'metadata-processor',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789:function:metadata-processor',
    memoryLimitInMB: '512',
    getRemainingTimeInMillis: () => 30000,
    callbackWaitsForEmptyEventLoop: false,
    logGroupName: '/aws/lambda/metadata-processor',
    logStreamName: '2024/01/01/test-stream',
    succeed: jest.fn(),
    fail: jest.fn(),
    done: jest.fn(),
  };

  const createS3Event = (bucketName: string, objectKey: string, eventName = 'ObjectCreated:Put'): S3Event => ({
    Records: [
      {
        eventVersion: '2.1',
        eventSource: 'aws:s3',
        awsRegion: 'us-east-1',
        eventTime: '2024-01-01T00:00:00.000Z',
        eventName,
        userIdentity: {
          principalId: 'AWS:test-user',
        },
        requestParameters: {
          sourceIPAddress: '127.0.0.1',
        },
        responseElements: {
          'x-amz-request-id': 'test-request',
          'x-amz-id-2': 'test-id',
        },
        s3: {
          s3SchemaVersion: '1.0',
          configurationId: 'test-config',
          bucket: {
            name: bucketName,
            ownerIdentity: {
              principalId: 'test-owner',
            },
            arn: `arn:aws:s3:::${bucketName}`,
          },
          object: {
            key: objectKey,
            size: 5000000,
            eTag: 'test-etag',
            sequencer: 'test-sequencer',
          },
        },
      },
    ],
  });

  beforeEach(() => {
    s3Mock.reset();
    dynamoMock.reset();
    sqsMock.reset();
    cloudWatchMock.reset();
    
    // Set required environment variables
    process.env.UPLOAD_BUCKET = 'test-bucket';
    process.env.UPLOAD_TABLE = 'test-table';
    process.env.QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue';
    process.env.NODE_ENV = 'test';

    // Default mocks
    s3Mock.on(GetObjectCommand).resolves({
      Body: new Readable({
        read() {
          this.push('test audio data');
          this.push(null);
        },
      }),
      ContentType: 'audio/mpeg',
      ContentLength: 5000000,
    });

    dynamoMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({
      MessageId: 'test-message-id',
    });
    cloudWatchMock.on(PutMetricDataCommand).resolves({});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('S3 Event Processing', () => {
    it('should successfully process MP3 file and extract metadata', async () => {
      const mockMetadata = {
        common: {
          title: 'Test Song',
          artist: 'Test Artist',
          album: 'Test Album',
          genre: ['Rock'],
          year: 2024,
          track: { no: 1 },
          disk: { no: 1 },
        },
        format: {
          duration: 180.5,
          bitrate: 320,
          sampleRate: 44100,
          numberOfChannels: 2,
        },
      };

      parseFile.mockResolvedValue(mockMetadata);

      const event = createS3Event('test-bucket', 'users/testuser/123e4567-e89b-12d3-a456-426614174000/song.mp3');
      
      await handler(event, mockContext);

      // Verify S3 GetObject was called
      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'users/testuser/123e4567-e89b-12d3-a456-426614174000/song.mp3',
        Range: 'bytes=0-16777215',
      });

      // Verify DynamoDB updates were called (status updates + metadata update)
      expect(dynamoMock.commandCalls(UpdateCommand).length).toBeGreaterThan(0);

      // Verify SQS message was sent
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
      const sqsCall = sqsMock.commandCalls(SendMessageCommand)[0];
      const messageBody = JSON.parse(sqsCall.args[0].input.MessageBody);
      expect(messageBody).toMatchObject({
        uploadId: '123e4567-e89b-12d3-a456-426614174000',
        userId: 'testuser',
        s3Key: 'users/testuser/123e4567-e89b-12d3-a456-426614174000/song.mp3',
        metadata: {
          title: 'Test Song',
          artist: 'Test Artist',
          album: 'Test Album',
          genre: 'Rock',
          year: 2024,
          duration: 180.5,
        },
      });

      // Verify CloudWatch metrics were published
      expect(cloudWatchMock.commandCalls(PutMetricDataCommand).length).toBeGreaterThan(0);
    });

    it('should handle FLAC files correctly', async () => {
      const mockMetadata = {
        common: {
          title: 'FLAC Test Song',
          artist: 'FLAC Artist',
        },
        format: {
          duration: 240.0,
          bitrate: 1411,
          sampleRate: 44100,
          numberOfChannels: 2,
        },
      };

      parseFile.mockResolvedValue(mockMetadata);

      const event = createS3Event('test-bucket', 'users/testuser/123e4567-e89b-12d3-a456-426614174001/song.flac');
      
      await handler(event, mockContext);

      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
      expect(dynamoMock.commandCalls(UpdateCommand).length).toBeGreaterThan(0);
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    });

    it('should save album artwork when present', async () => {
      const mockArtwork = {
        format: 'image/jpeg',
        data: Buffer.from('fake jpeg data'),
      };

      const mockMetadata = {
        common: {
          title: 'Song with Artwork',
          artist: 'Test Artist',
          picture: [mockArtwork],
        },
        format: {
          duration: 200.0,
        },
      };

      parseFile.mockResolvedValue(mockMetadata);

      const event = createS3Event('test-bucket', 'users/testuser/123e4567-e89b-12d3-a456-426614174002/song.mp3');
      
      await handler(event, mockContext);

      // Verify artwork was saved to S3
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
      const putCall = s3Mock.commandCalls(PutObjectCommand)[0];
      expect(putCall.args[0].input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'users/testuser/123e4567-e89b-12d3-a456-426614174002/song_artwork.jpg',
        ContentType: 'image/jpeg',
      });
    });

    it('should handle missing metadata gracefully', async () => {
      const mockMetadata = {
        common: {
          // No title or artist
        },
        format: {
          duration: 180.0,
        },
      };

      parseFile.mockResolvedValue(mockMetadata);

      const event = createS3Event('test-bucket', 'users/testuser/123e4567-e89b-12d3-a456-426614174003/unknown_song.mp3');
      
      await handler(event, mockContext);

      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
      const messageBody = JSON.parse(sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody);
      expect(messageBody.metadata).toMatchObject({
        title: 'unknown_song', // Extracted from filename
        artist: 'Unknown Artist', // Default fallback
        duration: 180.0,
      });
    });

    it('should skip non-ObjectCreated events', async () => {
      const event = createS3Event('test-bucket', 'users/testuser/123e4567-e89b-12d3-a456-426614174004/song.mp3', 'ObjectRemoved:Delete');
      
      await handler(event, mockContext);

      // Should not process the file
      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
      expect(parseFile).not.toHaveBeenCalled();
    });

    it('should reject unsupported file formats', async () => {
      const event = createS3Event('test-bucket', 'users/testuser/123e4567-e89b-12d3-a456-426614174005/document.pdf');
      
      await handler(event, mockContext);

      // Should not try to extract metadata
      expect(parseFile).not.toHaveBeenCalled();
      
      // Should publish failure metrics
      expect(cloudWatchMock.commandCalls(PutMetricDataCommand).length).toBeGreaterThan(0);
      const failureMetric = cloudWatchMock.commandCalls(PutMetricDataCommand)
        .find(call => call.args[0].input.MetricData[0].MetricName === 'ProcessingFailure');
      expect(failureMetric).toBeDefined();
    });

    it('should handle malformed S3 keys', async () => {
      const event = createS3Event('test-bucket', 'invalid/key/structure.mp3');
      
      await handler(event, mockContext);

      // Should not process the file
      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
      expect(parseFile).not.toHaveBeenCalled();
      
      // Should publish failure metrics
      expect(cloudWatchMock.commandCalls(PutMetricDataCommand).length).toBeGreaterThan(0);
    });

    it('should handle S3 errors gracefully', async () => {
      s3Mock.on(GetObjectCommand).rejects(new Error('S3 service unavailable'));

      const event = createS3Event('test-bucket', 'users/testuser/123e4567-e89b-12d3-a456-426614174006/song.mp3');
      
      await handler(event, mockContext);

      // Should publish failure metrics
      expect(cloudWatchMock.commandCalls(PutMetricDataCommand).length).toBeGreaterThan(0);
      const failureMetric = cloudWatchMock.commandCalls(PutMetricDataCommand)
        .find(call => call.args[0].input.MetricData[0].MetricName === 'ProcessingFailure');
      expect(failureMetric).toBeDefined();
    });

    it('should handle metadata parsing errors', async () => {
      parseFile.mockRejectedValue(new Error('Corrupted audio file'));

      const event = createS3Event('test-bucket', 'users/testuser/123e4567-e89b-12d3-a456-426614174007/corrupted.mp3');
      
      await handler(event, mockContext);

      // Should still try to update status to failed
      expect(dynamoMock.commandCalls(UpdateCommand).length).toBeGreaterThan(0);
      
      // Should publish failure metrics
      expect(cloudWatchMock.commandCalls(PutMetricDataCommand).length).toBeGreaterThan(0);
    });

    it('should process multiple S3 records', async () => {
      const mockMetadata = {
        common: { title: 'Test', artist: 'Test' },
        format: { duration: 100 },
      };
      parseFile.mockResolvedValue(mockMetadata);

      const event: S3Event = {
        Records: [
          ...createS3Event('test-bucket', 'users/user1/upload1/song1.mp3').Records,
          ...createS3Event('test-bucket', 'users/user2/upload2/song2.mp3').Records,
        ],
      };
      
      await handler(event, mockContext);

      // Should process both files
      expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(2);
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(2);
    });
  });

  describe('Error Handling', () => {
    it('should continue processing other records if one fails', async () => {
      const mockMetadata = {
        common: { title: 'Test', artist: 'Test' },
        format: { duration: 100 },
      };

      parseFile
        .mockRejectedValueOnce(new Error('First file corrupted'))
        .mockResolvedValueOnce(mockMetadata);

      const event: S3Event = {
        Records: [
          ...createS3Event('test-bucket', 'users/user1/upload1/bad.mp3').Records,
          ...createS3Event('test-bucket', 'users/user2/upload2/good.mp3').Records,
        ],
      };
      
      await handler(event, mockContext);

      // Should still process the good file
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
      
      // Should publish both success and failure metrics
      const metricCalls = cloudWatchMock.commandCalls(PutMetricDataCommand);
      const hasSuccess = metricCalls.some(call => 
        call.args[0].input.MetricData[0].MetricName === 'ProcessingSuccess'
      );
      const hasFailure = metricCalls.some(call => 
        call.args[0].input.MetricData[0].MetricName === 'ProcessingFailure'
      );
      
      expect(hasSuccess).toBe(true);
      expect(hasFailure).toBe(true);
    });
  });
});