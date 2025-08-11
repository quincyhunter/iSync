/**
 * Unit tests for queue-manager Lambda function
 */

import { ScheduledEvent, Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SQSClient,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import {
  LambdaClient,
  InvokeCommand,
} from '@aws-sdk/client-lambda';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import { handler } from './index';

// Mock AWS clients
const sqsMock = mockClient(SQSClient);
const lambdaMock = mockClient(LambdaClient);
const dynamoMock = mockClient(DynamoDBDocumentClient);
const cloudWatchMock = mockClient(CloudWatchClient);

describe('Queue Manager Lambda', () => {
  const mockContext: Context = {
    awsRequestId: 'test-request-id',
    functionName: 'queue-manager',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789:function:queue-manager',
    memoryLimitInMB: '512',
    getRemainingTimeInMillis: () => 30000,
    callbackWaitsForEmptyEventLoop: false,
    logGroupName: '/aws/lambda/queue-manager',
    logStreamName: '2024/01/01/test-stream',
    succeed: jest.fn(),
    fail: jest.fn(),
    done: jest.fn(),
  };

  const createScheduledEvent = (): ScheduledEvent => ({
    id: 'test-event-id',
    'detail-type': 'Scheduled Event',
    source: 'aws.events',
    account: '123456789',
    time: '2024-01-01T00:00:00Z',
    region: 'us-east-1',
    detail: {},
    resources: ['arn:aws:events:us-east-1:123456789:rule/queue-manager-schedule'],
  });

  beforeEach(() => {
    sqsMock.reset();
    lambdaMock.reset();
    dynamoMock.reset();
    cloudWatchMock.reset();

    // Set required environment variables
    process.env.QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue';
    process.env.NODE_ENV = 'test';
    process.env.AWS_REGION = 'us-east-1';

    // Default mocks
    cloudWatchMock.on(PutMetricDataCommand).resolves({});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Queue Monitoring', () => {
    it('should not trigger processing when queue is empty', async () => {
      // Mock empty queue
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: {
          ApproximateNumberOfMessages: '0',
          ApproximateNumberOfMessagesNotVisible: '0',
          ApproximateAgeOfOldestMessage: '0',
        },
      });

      // Mock processing state - no previous runs
      dynamoMock.on(GetCommand).resolves({
        Item: {
          stateKey: 'QUEUE_MANAGER',
          lastProcessingTime: 0,
          lastCheckTime: Date.now() - 60000, // 1 minute ago
          totalProcessed: 0,
          consecutiveSkips: 0,
        },
      });

      dynamoMock.on(PutCommand).resolves({});

      const event = createScheduledEvent();
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(200);
      expect(result.processingTriggered).toBe(false);
      expect(result.queueDepth).toBe(0);
      expect(result.reason).toBe('Queue is empty');

      // Should not invoke EC2 controller
      expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);

      // Should publish metrics
      expect(cloudWatchMock.commandCalls(PutMetricDataCommand).length).toBeGreaterThan(0);
    });

    it('should trigger processing when queue depth exceeds batch threshold', async () => {
      // Mock queue with 15 items (above threshold of 10)
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: {
          ApproximateNumberOfMessages: '15',
          ApproximateNumberOfMessagesNotVisible: '2',
          ApproximateAgeOfOldestMessage: '300',
        },
      });

      // Mock processing state
      dynamoMock.on(GetCommand).resolves({
        Item: {
          stateKey: 'QUEUE_MANAGER',
          lastProcessingTime: Date.now() - (2 * 60 * 60 * 1000), // 2 hours ago
          lastCheckTime: Date.now() - 60000, // 1 minute ago
          totalProcessed: 50,
          consecutiveSkips: 3,
        },
      });

      dynamoMock.on(PutCommand).resolves({});
      lambdaMock.on(InvokeCommand).resolves({
        StatusCode: 200,
        Payload: JSON.stringify({ statusCode: 200, desiredCapacity: 1 }),
      });

      const event = createScheduledEvent();
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(200);
      expect(result.processingTriggered).toBe(true);
      expect(result.queueDepth).toBe(15);
      expect(result.reason).toContain('exceeds batch threshold');

      // Should invoke EC2 controller
      expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
      const invokeCall = lambdaMock.commandCalls(InvokeCommand)[0];
      const payload = JSON.parse(invokeCall.args[0].input.Payload);
      expect(payload).toMatchObject({
        action: 'scale',
        queueDepth: 15,
        desiredCapacity: 1, // 15 items = 1 instance
        reason: expect.stringContaining('exceeds batch threshold'),
      });

      // Should update processing state with new processing time
      expect(dynamoMock.commandCalls(PutCommand).length).toBeGreaterThan(0);
    });

    it('should trigger processing when queue has items and max wait time exceeded', async () => {
      // Mock queue with 5 items (below threshold but has items)
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: {
          ApproximateNumberOfMessages: '5',
          ApproximateNumberOfMessagesNotVisible: '0',
          ApproximateAgeOfOldestMessage: '3600',
        },
      });

      // Mock processing state - last run was 7 hours ago (exceeds 6 hour max wait)
      const sevenHoursAgo = Date.now() - (7 * 60 * 60 * 1000);
      dynamoMock.on(GetCommand).resolves({
        Item: {
          stateKey: 'QUEUE_MANAGER',
          lastProcessingTime: sevenHoursAgo,
          lastCheckTime: Date.now() - 60000,
          totalProcessed: 25,
          consecutiveSkips: 5,
        },
      });

      dynamoMock.on(PutCommand).resolves({});
      lambdaMock.on(InvokeCommand).resolves({
        StatusCode: 200,
        Payload: JSON.stringify({ statusCode: 200 }),
      });

      const event = createScheduledEvent();
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(200);
      expect(result.processingTriggered).toBe(true);
      expect(result.queueDepth).toBe(5);
      expect(result.reason).toContain('7.0 hours ago');

      // Should invoke EC2 controller
      expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
    });

    it('should not trigger processing when queue has items but last run was recent', async () => {
      // Mock queue with 5 items
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: {
          ApproximateNumberOfMessages: '5',
          ApproximateNumberOfMessagesNotVisible: '0',
          ApproximateAgeOfOldestMessage: '1800',
        },
      });

      // Mock processing state - last run was 15 minutes ago (below 30 min threshold)
      const fifteenMinutesAgo = Date.now() - (15 * 60 * 1000);
      dynamoMock.on(GetCommand).resolves({
        Item: {
          stateKey: 'QUEUE_MANAGER',
          lastProcessingTime: fifteenMinutesAgo,
          lastCheckTime: Date.now() - 60000,
          totalProcessed: 30,
          consecutiveSkips: 2,
        },
      });

      dynamoMock.on(PutCommand).resolves({});

      const event = createScheduledEvent();
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(200);
      expect(result.processingTriggered).toBe(false);
      expect(result.queueDepth).toBe(5);
      expect(result.reason).toContain('only 15.0 minutes ago');

      // Should not invoke EC2 controller
      expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
    });

    it('should calculate correct desired capacity based on queue depth', async () => {
      const testCases = [
        { queueDepth: 25, expectedCapacity: 1 },  // <= 50
        { queueDepth: 75, expectedCapacity: 2 },  // <= 100
        { queueDepth: 150, expectedCapacity: 3 }, // <= 200
        { queueDepth: 500, expectedCapacity: 5 }, // > 200
      ];

      for (const testCase of testCases) {
        sqsMock.reset();
        lambdaMock.reset();
        dynamoMock.reset();

        sqsMock.on(GetQueueAttributesCommand).resolves({
          Attributes: {
            ApproximateNumberOfMessages: testCase.queueDepth.toString(),
          },
        });

        dynamoMock.on(GetCommand).resolves({
          Item: {
            stateKey: 'QUEUE_MANAGER',
            lastProcessingTime: 0, // Never run before
            lastCheckTime: Date.now(),
            totalProcessed: 0,
            consecutiveSkips: 0,
          },
        });

        dynamoMock.on(PutCommand).resolves({});
        lambdaMock.on(InvokeCommand).resolves({
          StatusCode: 200,
          Payload: JSON.stringify({ statusCode: 200 }),
        });

        const event = createScheduledEvent();
        await handler(event, mockContext);

        // Should invoke EC2 controller with correct capacity
        expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
        const payload = JSON.parse(lambdaMock.commandCalls(InvokeCommand)[0].args[0].input.Payload);
        expect(payload.desiredCapacity).toBe(testCase.expectedCapacity);
      }
    });
  });

  describe('State Management', () => {
    it('should handle missing processing state gracefully', async () => {
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: {
          ApproximateNumberOfMessages: '15',
        },
      });

      // Mock missing state (no Item returned)
      dynamoMock.on(GetCommand).resolves({});
      dynamoMock.on(PutCommand).resolves({});
      lambdaMock.on(InvokeCommand).resolves({
        StatusCode: 200,
        Payload: JSON.stringify({ statusCode: 200 }),
      });

      const event = createScheduledEvent();
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(200);
      expect(result.processingTriggered).toBe(true);

      // Should still process with default state
      expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
    });

    it('should handle DynamoDB table not found error', async () => {
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: {
          ApproximateNumberOfMessages: '15',
        },
      });

      // Mock ResourceNotFoundException
      dynamoMock.on(GetCommand).rejects({
        name: 'ResourceNotFoundException',
        message: 'Table not found',
      });
      
      dynamoMock.on(PutCommand).resolves({});
      lambdaMock.on(InvokeCommand).resolves({
        StatusCode: 200,
        Payload: JSON.stringify({ statusCode: 200 }),
      });

      const event = createScheduledEvent();
      const result = await handler(event, mockContext) as any;

      expect(result.statusCode).toBe(200);
      expect(result.processingTriggered).toBe(true);

      // Should still process with default state
      expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
    });

    it('should update consecutive skips counter', async () => {
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: {
          ApproximateNumberOfMessages: '3', // Below threshold
        },
      });

      dynamoMock.on(GetCommand).resolves({
        Item: {
          stateKey: 'QUEUE_MANAGER',
          lastProcessingTime: Date.now() - (2 * 60 * 60 * 1000), // 2 hours ago
          lastCheckTime: Date.now() - 60000,
          totalProcessed: 10,
          consecutiveSkips: 5,
        },
      });

      let capturedState: any;
      dynamoMock.on(PutCommand).callsFake((params) => {
        capturedState = params.Item;
        return Promise.resolve({});
      });

      const event = createScheduledEvent();
      await handler(event, mockContext);

      // Should increment consecutive skips
      expect(capturedState.consecutiveSkips).toBe(6);
    });
  });

  describe('Error Handling', () => {
    it('should handle SQS errors gracefully', async () => {
      sqsMock.on(GetQueueAttributesCommand).rejects(new Error('SQS service unavailable'));

      const event = createScheduledEvent();
      
      await expect(handler(event, mockContext)).rejects.toThrow('SQS service unavailable');

      // Should publish failure metrics
      expect(cloudWatchMock.commandCalls(PutMetricDataCommand).length).toBeGreaterThan(0);
      const failureMetric = cloudWatchMock.commandCalls(PutMetricDataCommand)
        .find(call => call.args[0].input.MetricData[0].MetricName === 'CheckFailed');
      expect(failureMetric).toBeDefined();
    });

    it('should handle EC2 controller invocation errors', async () => {
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: {
          ApproximateNumberOfMessages: '15',
        },
      });

      dynamoMock.on(GetCommand).resolves({
        Item: {
          stateKey: 'QUEUE_MANAGER',
          lastProcessingTime: 0,
          lastCheckTime: Date.now(),
          totalProcessed: 0,
          consecutiveSkips: 0,
        },
      });

      dynamoMock.on(PutCommand).resolves({});

      // Mock Lambda invocation failure
      lambdaMock.on(InvokeCommand).rejects(new Error('Lambda invocation failed'));

      const event = createScheduledEvent();
      
      await expect(handler(event, mockContext)).rejects.toThrow('Lambda invocation failed');
    });

    it('should handle EC2 controller function errors', async () => {
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: {
          ApproximateNumberOfMessages: '15',
        },
      });

      dynamoMock.on(GetCommand).resolves({
        Item: {
          stateKey: 'QUEUE_MANAGER',
          lastProcessingTime: 0,
          lastCheckTime: Date.now(),
          totalProcessed: 0,
          consecutiveSkips: 0,
        },
      });

      dynamoMock.on(PutCommand).resolves({});

      // Mock Lambda function error
      lambdaMock.on(InvokeCommand).resolves({
        StatusCode: 200,
        FunctionError: 'Handled',
        Payload: JSON.stringify({ errorType: 'Error', errorMessage: 'Function failed' }),
      });

      const event = createScheduledEvent();
      
      await expect(handler(event, mockContext)).rejects.toThrow('EC2 controller returned error');
    });

    it('should continue execution if state update fails', async () => {
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: {
          ApproximateNumberOfMessages: '0',
        },
      });

      dynamoMock.on(GetCommand).resolves({
        Item: {
          stateKey: 'QUEUE_MANAGER',
          lastProcessingTime: 0,
          lastCheckTime: Date.now(),
          totalProcessed: 0,
          consecutiveSkips: 0,
        },
      });

      // Mock state update failure
      dynamoMock.on(PutCommand).rejects(new Error('DynamoDB update failed'));

      const event = createScheduledEvent();
      const result = await handler(event, mockContext) as any;

      // Should still complete successfully
      expect(result.statusCode).toBe(200);
    });

    it('should continue execution if metrics publishing fails', async () => {
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: {
          ApproximateNumberOfMessages: '0',
        },
      });

      dynamoMock.on(GetCommand).resolves({
        Item: {
          stateKey: 'QUEUE_MANAGER',
          lastProcessingTime: 0,
          lastCheckTime: Date.now(),
          totalProcessed: 0,
          consecutiveSkips: 0,
        },
      });

      dynamoMock.on(PutCommand).resolves({});

      // Mock CloudWatch failure
      cloudWatchMock.on(PutMetricDataCommand).rejects(new Error('CloudWatch unavailable'));

      const event = createScheduledEvent();
      const result = await handler(event, mockContext) as any;

      // Should still complete successfully
      expect(result.statusCode).toBe(200);
    });
  });

  describe('Metrics Publishing', () => {
    it('should publish comprehensive CloudWatch metrics', async () => {
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: {
          ApproximateNumberOfMessages: '15',
        },
      });

      dynamoMock.on(GetCommand).resolves({
        Item: {
          stateKey: 'QUEUE_MANAGER',
          lastProcessingTime: Date.now() - (30 * 60 * 1000), // 30 min ago
          lastCheckTime: Date.now() - (5 * 60 * 1000), // 5 min ago
          totalProcessed: 100,
          consecutiveSkips: 0,
        },
      });

      dynamoMock.on(PutCommand).resolves({});
      lambdaMock.on(InvokeCommand).resolves({
        StatusCode: 200,
        Payload: JSON.stringify({ statusCode: 200 }),
      });

      const event = createScheduledEvent();
      await handler(event, mockContext);

      // Should publish multiple metrics
      const metricCalls = cloudWatchMock.commandCalls(PutMetricDataCommand);
      expect(metricCalls.length).toBeGreaterThan(3);

      // Check for specific metrics
      const metricNames = metricCalls.map(call => 
        call.args[0].input.MetricData[0].MetricName
      );

      expect(metricNames).toContain('QueueDepth');
      expect(metricNames).toContain('ProcessingTriggered');
      expect(metricNames).toContain('TimeSinceLastRun');
      expect(metricNames).toContain('CheckCompleted');
    });
  });
});