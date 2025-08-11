/**
 * Unit tests for ec2-controller Lambda function
 */

import { Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  SetDesiredCapacityCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  EC2Client,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import { handler } from './index';

// Mock AWS clients
const autoScalingMock = mockClient(AutoScalingClient);
const ec2Mock = mockClient(EC2Client);
const cloudWatchMock = mockClient(CloudWatchClient);

describe('EC2 Controller Lambda', () => {
  const mockContext: Context = {
    awsRequestId: 'test-request-id',
    functionName: 'ec2-controller',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789:function:ec2-controller',
    memoryLimitInMB: '256',
    getRemainingTimeInMillis: () => 30000,
    callbackWaitsForEmptyEventLoop: false,
    logGroupName: '/aws/lambda/ec2-controller',
    logStreamName: '2024/01/01/test-stream',
    succeed: jest.fn(),
    fail: jest.fn(),
    done: jest.fn(),
  };

  beforeEach(() => {
    autoScalingMock.reset();
    ec2Mock.reset();
    cloudWatchMock.reset();

    // Set required environment variables
    process.env.AUTO_SCALING_GROUP_NAME = 'isync-processing-asg';
    process.env.NODE_ENV = 'test';

    // Default mocks
    cloudWatchMock.on(PutMetricDataCommand).resolves({});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Scaling Operations', () => {
    it('should scale up Auto Scaling Group when requested', async () => {
      // Mock current ASG state (0 instances) - first call
      autoScalingMock.on(DescribeAutoScalingGroupsCommand)
        .resolvesOnce({
          AutoScalingGroups: [
            {
              AutoScalingGroupName: 'test-isync-processing-asg',
              DesiredCapacity: 0,
              MinSize: 0,
              MaxSize: 5,
              Instances: [],
            },
          ],
        })
        // Mock updated ASG state after scaling - second call
        .resolvesOnce({
          AutoScalingGroups: [
            {
              AutoScalingGroupName: 'test-isync-processing-asg',
              DesiredCapacity: 2,
              MinSize: 0,
              MaxSize: 5,
              Instances: [
                {
                  InstanceId: 'i-1234567890abcdef0',
                  LifecycleState: 'Pending',
                },
                {
                  InstanceId: 'i-0987654321fedcba0',
                  LifecycleState: 'Pending',
                },
              ],
            },
          ],
        });

      // Mock successful capacity setting
      autoScalingMock.on(SetDesiredCapacityCommand).resolves({});

      // Mock EC2 instances (not running yet)
      ec2Mock.on(DescribeInstancesCommand).resolves({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-1234567890abcdef0',
                State: { Name: 'pending' },
                LaunchTime: new Date('2024-01-01T00:00:00Z'),
              },
              {
                InstanceId: 'i-0987654321fedcba0',
                State: { Name: 'pending' },
                LaunchTime: new Date('2024-01-01T00:01:00Z'),
              },
            ],
          },
        ],
      });

      const event = {
        action: 'scale' as const,
        queueDepth: 75,
        desiredCapacity: 2,
        reason: 'Queue depth exceeded threshold',
        timestamp: Date.now(),
      };

      const result = await handler(event, mockContext);

      expect(result.statusCode).toBe(200);
      expect(result.currentCapacity).toBe(2);
      expect(result.desiredCapacity).toBe(2);
      expect(result.runningInstances).toBe(0); // Still pending
      expect(result.estimatedHourlyCost).toBeCloseTo(0.0232); // 2 * 0.0116
      expect(result.message).toContain('scaled to 2 instances');

      // Verify SetDesiredCapacity was called
      expect(autoScalingMock.commandCalls(SetDesiredCapacityCommand)).toHaveLength(1);
      const setCapacityCall = autoScalingMock.commandCalls(SetDesiredCapacityCommand)[0];
      expect(setCapacityCall.args[0].input).toMatchObject({
        AutoScalingGroupName: 'isync-processing-asg',
        DesiredCapacity: 2,
        HonorCooldown: false,
      });

      // Verify metrics were published
      expect(cloudWatchMock.commandCalls(PutMetricDataCommand).length).toBeGreaterThan(0);
    });

    it('should not scale if desired capacity is already set', async () => {
      // Mock current ASG state (already at desired capacity)
      autoScalingMock.on(DescribeAutoScalingGroupsCommand).resolves({
        AutoScalingGroups: [
          {
            AutoScalingGroupName: 'isync-processing-asg',
            DesiredCapacity: 2,
            MinSize: 0,
            MaxSize: 5,
            Instances: [
              {
                InstanceId: 'i-1234567890abcdef0',
                LifecycleState: 'InService',
              },
              {
                InstanceId: 'i-0987654321fedcba0',
                LifecycleState: 'InService',
              },
            ],
          },
        ],
      });

      // Mock running EC2 instances
      ec2Mock.on(DescribeInstancesCommand).resolves({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-1234567890abcdef0',
                State: { Name: 'running' },
                LaunchTime: new Date('2024-01-01T00:00:00Z'),
              },
              {
                InstanceId: 'i-0987654321fedcba0',
                State: { Name: 'running' },
                LaunchTime: new Date('2024-01-01T00:01:00Z'),
              },
            ],
          },
        ],
      });

      const event = {
        action: 'scale' as const,
        queueDepth: 75,
        desiredCapacity: 2,
        reason: 'Queue depth exceeded threshold',
        timestamp: Date.now(),
      };

      const result = await handler(event, mockContext);

      expect(result.statusCode).toBe(200);
      expect(result.currentCapacity).toBe(2);
      expect(result.desiredCapacity).toBe(2);
      expect(result.runningInstances).toBe(2);
      expect(result.message).toContain('No scaling needed');

      // Verify SetDesiredCapacity was NOT called
      expect(autoScalingMock.commandCalls(SetDesiredCapacityCommand)).toHaveLength(0);
    });

    it('should constrain desired capacity within limits', async () => {
      autoScalingMock.on(DescribeAutoScalingGroupsCommand).resolves({
        AutoScalingGroups: [
          {
            AutoScalingGroupName: 'isync-processing-asg',
            DesiredCapacity: 0,
            MinSize: 0,
            MaxSize: 5,
            Instances: [],
          },
        ],
      });

      autoScalingMock.on(SetDesiredCapacityCommand).resolves({});

      const event = {
        action: 'scale' as const,
        queueDepth: 1000,
        desiredCapacity: 10, // Exceeds max of 5
        reason: 'Very large queue',
        timestamp: Date.now(),
      };

      const result = await handler(event, mockContext);

      expect(result.statusCode).toBe(200);
      
      // Should have been constrained to max capacity of 5
      const setCapacityCall = autoScalingMock.commandCalls(SetDesiredCapacityCommand)[0];
      expect(setCapacityCall.args[0].input.DesiredCapacity).toBe(5);
    });

    it('should handle negative desired capacity by setting to 0', async () => {
      autoScalingMock.on(DescribeAutoScalingGroupsCommand).resolves({
        AutoScalingGroups: [
          {
            AutoScalingGroupName: 'isync-processing-asg',
            DesiredCapacity: 2,
            MinSize: 0,
            MaxSize: 5,
            Instances: [],
          },
        ],
      });

      autoScalingMock.on(SetDesiredCapacityCommand).resolves({});

      const event = {
        action: 'scale' as const,
        queueDepth: 0,
        desiredCapacity: -1, // Negative value
        reason: 'Scale down',
        timestamp: Date.now(),
      };

      const result = await handler(event, mockContext);

      expect(result.statusCode).toBe(200);
      
      // Should have been constrained to min capacity of 0
      const setCapacityCall = autoScalingMock.commandCalls(SetDesiredCapacityCommand)[0];
      expect(setCapacityCall.args[0].input.DesiredCapacity).toBe(0);
    });
  });

  describe('Describe Operation', () => {
    it('should return current Auto Scaling Group status', async () => {
      autoScalingMock.on(DescribeAutoScalingGroupsCommand).resolves({
        AutoScalingGroups: [
          {
            AutoScalingGroupName: 'isync-processing-asg',
            DesiredCapacity: 3,
            MinSize: 0,
            MaxSize: 5,
            Instances: [
              {
                InstanceId: 'i-1234567890abcdef0',
                LifecycleState: 'InService',
              },
              {
                InstanceId: 'i-0987654321fedcba0',
                LifecycleState: 'InService',
              },
              {
                InstanceId: 'i-1111222233334444',
                LifecycleState: 'Pending',
              },
            ],
          },
        ],
      });

      ec2Mock.on(DescribeInstancesCommand).resolves({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-1234567890abcdef0',
                State: { Name: 'running' },
                LaunchTime: new Date('2024-01-01T00:00:00Z'),
              },
              {
                InstanceId: 'i-0987654321fedcba0',
                State: { Name: 'running' },
                LaunchTime: new Date('2024-01-01T00:01:00Z'),
              },
              {
                InstanceId: 'i-1111222233334444',
                State: { Name: 'pending' },
                LaunchTime: new Date('2024-01-01T00:02:00Z'),
              },
            ],
          },
        ],
      });

      const event = {
        action: 'describe' as const,
        timestamp: Date.now(),
      };

      const result = await handler(event, mockContext);

      expect(result.statusCode).toBe(200);
      expect(result.currentCapacity).toBe(3);
      expect(result.desiredCapacity).toBe(3);
      expect(result.runningInstances).toBe(2);
      expect(result.estimatedHourlyCost).toBeCloseTo(0.0348); // 3 * 0.0116
      expect(result.message).toContain('3 instances');
      expect(result.instances).toHaveLength(3);
      expect(result.instances![0]).toMatchObject({
        instanceId: 'i-1234567890abcdef0',
        state: 'running',
        launchTime: '2024-01-01T00:00:00.000Z',
      });
    });
  });

  describe('Terminate Operation', () => {
    it('should scale down Auto Scaling Group to 0', async () => {
      // Mock current ASG state (has instances)
      autoScalingMock.on(DescribeAutoScalingGroupsCommand).resolves({
        AutoScalingGroups: [
          {
            AutoScalingGroupName: 'isync-processing-asg',
            DesiredCapacity: 2,
            MinSize: 0,
            MaxSize: 5,
            Instances: [
              {
                InstanceId: 'i-1234567890abcdef0',
                LifecycleState: 'InService',
              },
              {
                InstanceId: 'i-0987654321fedcba0',
                LifecycleState: 'InService',
              },
            ],
          },
        ],
      });

      autoScalingMock.on(SetDesiredCapacityCommand).resolves({});

      // Mock updated ASG state after termination
      autoScalingMock.on(DescribeAutoScalingGroupsCommand).resolves({
        AutoScalingGroups: [
          {
            AutoScalingGroupName: 'isync-processing-asg',
            DesiredCapacity: 0,
            MinSize: 0,
            MaxSize: 5,
            Instances: [],
          },
        ],
      });

      const event = {
        action: 'terminate' as const,
        timestamp: Date.now(),
      };

      const result = await handler(event, mockContext);

      expect(result.statusCode).toBe(200);
      expect(result.currentCapacity).toBe(0);
      expect(result.desiredCapacity).toBe(0);
      expect(result.runningInstances).toBe(0);
      expect(result.estimatedHourlyCost).toBe(0);
      expect(result.message).toContain('All instances terminated');

      // Verify SetDesiredCapacity was called with 0
      expect(autoScalingMock.commandCalls(SetDesiredCapacityCommand)).toHaveLength(1);
      const setCapacityCall = autoScalingMock.commandCalls(SetDesiredCapacityCommand)[0];
      expect(setCapacityCall.args[0].input).toMatchObject({
        AutoScalingGroupName: 'isync-processing-asg',
        DesiredCapacity: 0,
        HonorCooldown: false,
      });
    });
  });

  describe('Error Handling', () => {
    it('should return error for invalid action', async () => {
      const event = {
        action: 'invalid' as any,
        timestamp: Date.now(),
      };

      const result = await handler(event, mockContext);

      expect(result.statusCode).toBe(400);
      expect(result.message).toContain('Invalid action: invalid');
    });

    it('should return error for scale action without desiredCapacity', async () => {
      const event = {
        action: 'scale' as const,
        queueDepth: 50,
        // desiredCapacity missing
        reason: 'Test',
        timestamp: Date.now(),
      };

      const result = await handler(event, mockContext);

      expect(result.statusCode).toBe(400);
      expect(result.message).toContain('desiredCapacity is required');
    });

    it('should handle Auto Scaling Group not found', async () => {
      autoScalingMock.on(DescribeAutoScalingGroupsCommand).resolves({
        AutoScalingGroups: [], // Empty array means ASG not found
      });

      const event = {
        action: 'describe' as const,
        timestamp: Date.now(),
      };

      const result = await handler(event, mockContext);

      expect(result.statusCode).toBe(500);
      expect(result.message).toContain('not found');
    });

    it('should handle Auto Scaling service errors', async () => {
      autoScalingMock.on(DescribeAutoScalingGroupsCommand).rejects(
        new Error('Auto Scaling service unavailable')
      );

      const event = {
        action: 'describe' as const,
        timestamp: Date.now(),
      };

      const result = await handler(event, mockContext);

      expect(result.statusCode).toBe(500);
      expect(result.message).toContain('Auto Scaling service unavailable');
    });

    it('should handle SetDesiredCapacity validation errors', async () => {
      autoScalingMock.on(DescribeAutoScalingGroupsCommand).resolves({
        AutoScalingGroups: [
          {
            AutoScalingGroupName: 'isync-processing-asg',
            DesiredCapacity: 0,
            MinSize: 0,
            MaxSize: 5,
            Instances: [],
          },
        ],
      });

      // Mock ValidationError from AWS
      autoScalingMock.on(SetDesiredCapacityCommand).rejects({
        name: 'ValidationError',
        message: 'Invalid desired capacity value',
      });

      const event = {
        action: 'scale' as const,
        queueDepth: 50,
        desiredCapacity: 2,
        reason: 'Test scaling',
        timestamp: Date.now(),
      };

      const result = await handler(event, mockContext);

      expect(result.statusCode).toBe(400);
      expect(result.message).toContain('Invalid scaling parameters');
    });

    it('should continue if EC2 instance counting fails', async () => {
      autoScalingMock.on(DescribeAutoScalingGroupsCommand).resolves({
        AutoScalingGroups: [
          {
            AutoScalingGroupName: 'isync-processing-asg',
            DesiredCapacity: 1,
            MinSize: 0,
            MaxSize: 5,
            Instances: [
              {
                InstanceId: 'i-1234567890abcdef0',
                LifecycleState: 'InService',
              },
            ],
          },
        ],
      });

      // Mock EC2 service error
      ec2Mock.on(DescribeInstancesCommand).rejects(
        new Error('EC2 service unavailable')
      );

      const event = {
        action: 'describe' as const,
        timestamp: Date.now(),
      };

      const result = await handler(event, mockContext);

      // Should still succeed, but with runningInstances = 0
      expect(result.statusCode).toBe(200);
      expect(result.currentCapacity).toBe(1);
      expect(result.runningInstances).toBe(0);
    });

    it('should continue if metrics publishing fails', async () => {
      autoScalingMock.on(DescribeAutoScalingGroupsCommand).resolves({
        AutoScalingGroups: [
          {
            AutoScalingGroupName: 'isync-processing-asg',
            DesiredCapacity: 1,
            MinSize: 0,
            MaxSize: 5,
            Instances: [
              {
                InstanceId: 'i-1234567890abcdef0',
                LifecycleState: 'InService',
              },
            ],
          },
        ],
      });

      // Mock CloudWatch error for failure metrics, but allow initial success metrics to fail too
      cloudWatchMock.on(PutMetricDataCommand).rejects(
        new Error('CloudWatch unavailable')
      );

      const event = {
        action: 'describe' as const,
        timestamp: Date.now(),
      };

      // The function should succeed despite metrics publishing failure
      const result = await handler(event, mockContext);

      // Should still succeed since metrics failure is handled
      expect(result.statusCode).toBe(200);
      expect(result.currentCapacity).toBe(1);
    });
  });

  describe('Cost Estimation', () => {
    it('should calculate correct hourly cost for different instance counts', async () => {
      const testCases = [
        { instances: 0, expectedCost: 0 },
        { instances: 1, expectedCost: 0.0116 },
        { instances: 3, expectedCost: 0.0348 },
        { instances: 5, expectedCost: 0.058 },
      ];

      for (const testCase of testCases) {
        autoScalingMock.reset();
        
        autoScalingMock.on(DescribeAutoScalingGroupsCommand).resolves({
          AutoScalingGroups: [
            {
              AutoScalingGroupName: 'test-isync-processing-asg',
              DesiredCapacity: testCase.instances,
              MinSize: 0,
              MaxSize: 5,
              Instances: Array.from({ length: testCase.instances }, (_, i) => ({
                InstanceId: `i-${i.toString().padStart(16, '0')}`,
                LifecycleState: 'InService',
              })),
            },
          ],
        });

        const event = {
          action: 'describe' as const,
          timestamp: Date.now(),
        };

        const result = await handler(event, mockContext);

        expect(result.estimatedHourlyCost).toBeCloseTo(testCase.expectedCost);
      }
    });
  });
});