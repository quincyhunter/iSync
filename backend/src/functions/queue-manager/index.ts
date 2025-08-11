/**
 * Queue Manager Lambda Function
 * 
 * Monitors SQS queue depth and triggers EC2 processing instances when thresholds are met.
 * Triggered by EventBridge every 5 minutes to check queue metrics and decide on scaling actions.
 */

import { ScheduledEvent, ScheduledHandler } from 'aws-lambda';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { UpdateCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { awsClients, sqs, document } from '@shared/aws-clients';
import logger from '@shared/logger';
import {
  getLambdaConfig,
  retry,
  createRetryConfig,
  getRequestId,
} from '@shared/utils';
import {
  AWSServiceError,
  ErrorCode,
  iSyncError,
} from '@shared/errors';
import { ProcessingMetrics, EC2ScalingDecision } from '@shared/types';

// Lambda configuration
const config = getLambdaConfig();

// Queue processing thresholds and configuration
const PROCESSING_THRESHOLDS = {
  BATCH_THRESHOLD: 10, // Trigger processing if queue >= 10 items
  MAX_WAIT_HOURS: 6,   // Trigger processing if queue > 0 and last run > 6 hours ago
  MIN_PROCESSING_INTERVAL_MINUTES: 30, // Minimum time between processing runs
} as const;

// DynamoDB table and key for storing processing state
const PROCESSING_STATE_TABLE = 'isync-processing-state';
const PROCESSING_STATE_KEY = 'QUEUE_MANAGER';

interface ProcessingState {
  stateKey: string;
  lastProcessingTime: number;
  lastCheckTime: number;
  totalProcessed: number;
  consecutiveSkips: number;
}

/**
 * Main Lambda handler for EventBridge scheduled events
 */
export const handler: ScheduledHandler = async (event: ScheduledEvent, context) => {
  const requestId = getRequestId(context);
  
  logger.setContext({
    requestId,
    functionName: context.functionName,
  });

  logger.info('Queue manager triggered', {
    source: event.source,
    time: event.time,
    resources: event.resources,
  });

  try {
    // Get current queue metrics
    const queueMetrics = await getQueueMetrics();
    
    // Get processing state from DynamoDB
    const processingState = await getProcessingState();
    
    // Make scaling decision
    const scalingDecision = makeScalingDecision(queueMetrics, processingState);
    
    // Update processing state
    await updateProcessingState({
      ...processingState,
      lastCheckTime: Date.now(),
      consecutiveSkips: scalingDecision.shouldScale ? 0 : processingState.consecutiveSkips + 1,
    });

    // Publish queue metrics to CloudWatch
    await publishQueueMetrics(queueMetrics, scalingDecision);
    
    if (scalingDecision.shouldScale) {
      // Invoke EC2 controller to scale up instances
      await invokeEC2Controller(scalingDecision);
      
      // Update last processing time
      await updateProcessingState({
        ...processingState,
        lastProcessingTime: Date.now(),
        lastCheckTime: Date.now(),
        totalProcessed: processingState.totalProcessed + queueMetrics.queueDepth,
        consecutiveSkips: 0,
      });
      
      logger.info('Processing triggered successfully', {
        queueDepth: queueMetrics.queueDepth,
        desiredCapacity: scalingDecision.desiredCapacity,
        reason: scalingDecision.reason,
      });
    } else {
      logger.info('Processing not triggered', {
        queueDepth: queueMetrics.queueDepth,
        reason: scalingDecision.reason,
        consecutiveSkips: processingState.consecutiveSkips + 1,
      });
    }

    // Publish success metrics
    try {
      await awsClients.publishMetric(
        'iSync/QueueManager',
        'CheckCompleted',
        1,
        'Count',
        [
          { Name: 'Environment', Value: config.nodeEnv },
          { Name: 'ProcessingTriggered', Value: scalingDecision.shouldScale ? '1' : '0' },
        ]
      );
    } catch (metricsError) {
      // Don't fail the entire process if metrics publishing fails
      logger.warn('Failed to publish success metrics', {
        error: metricsError instanceof Error ? metricsError.message : String(metricsError),
      });
    }

    return {
      statusCode: 200,
      queueDepth: queueMetrics.queueDepth,
      processingTriggered: scalingDecision.shouldScale,
      reason: scalingDecision.reason,
    };

  } catch (error) {
    logger.error('Queue manager execution failed', error, { requestId });
    
    // Publish failure metrics
    try {
      await awsClients.publishMetric(
        'iSync/QueueManager',
        'CheckFailed',
        1,
        'Count',
        [
          { Name: 'Environment', Value: config.nodeEnv },
          { Name: 'ErrorType', Value: error instanceof Error ? error.constructor.name : 'Unknown' },
        ]
      );
    } catch (metricsError) {
      // Don't fail the entire process if metrics publishing fails
      logger.warn('Failed to publish failure metrics', {
        error: metricsError instanceof Error ? metricsError.message : String(metricsError),
      });
    }

    throw error;
  } finally {
    logger.clearContext();
  }
};

/**
 * Get current SQS queue metrics
 */
async function getQueueMetrics(): Promise<ProcessingMetrics> {
  try {
    const command = new GetQueueAttributesCommand({
      QueueUrl: config.queueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateAgeOfOldestMessage',
      ],
    });

    const result = await retry(
      () => sqs.send(command),
      createRetryConfig(),
      'getQueueAttributes'
    );

    const attributes = result.Attributes || {};
    const queueDepth = parseInt(attributes.ApproximateNumberOfMessages || '0', 10);
    const messagesInFlight = parseInt(attributes.ApproximateNumberOfMessagesNotVisible || '0', 10);
    const oldestMessageAge = parseInt(attributes.ApproximateAgeOfOldestMessage || '0', 10);

    logger.debug('Queue metrics retrieved', {
      queueDepth,
      messagesInFlight,
      oldestMessageAge,
    });

    return {
      queueDepth,
      runningInstances: 0, // Will be filled by EC2 controller if needed
      lastProcessingTime: 0, // Will be filled from processing state
      averageProcessingTime: 0, // Could be calculated from historical data
      successRate: 1.0, // Could be calculated from metrics
    };

  } catch (error) {
    throw new AWSServiceError(
      'SQS',
      ErrorCode.SQS_ERROR,
      `Failed to get queue attributes: ${error instanceof Error ? error.message : String(error)}`,
      true,
      error as Error
    );
  }
}

/**
 * Get processing state from DynamoDB
 */
async function getProcessingState(): Promise<ProcessingState> {
  try {
    const command = new GetCommand({
      TableName: PROCESSING_STATE_TABLE,
      Key: {
        stateKey: PROCESSING_STATE_KEY,
      },
    });

    const result = await retry(
      () => document.send(command),
      createRetryConfig(),
      'getProcessingState'
    );

    if (result.Item) {
      return result.Item as ProcessingState;
    }

    // Return default state if not found
    const defaultState: ProcessingState = {
      stateKey: PROCESSING_STATE_KEY,
      lastProcessingTime: 0,
      lastCheckTime: Date.now(),
      totalProcessed: 0,
      consecutiveSkips: 0,
    };

    logger.debug('No processing state found, using defaults', defaultState);
    return defaultState;

  } catch (error) {
    if (error instanceof Error && error.name === 'ResourceNotFoundException') {
      // Table doesn't exist, return default state
      logger.warn('Processing state table not found, using defaults');
      return {
        stateKey: PROCESSING_STATE_KEY,
        lastProcessingTime: 0,
        lastCheckTime: Date.now(),
        totalProcessed: 0,
        consecutiveSkips: 0,
      };
    }

    throw new AWSServiceError(
      'DynamoDB',
      ErrorCode.DYNAMODB_ERROR,
      `Failed to get processing state: ${error instanceof Error ? error.message : String(error)}`,
      true,
      error as Error
    );
  }
}

/**
 * Update processing state in DynamoDB
 */
async function updateProcessingState(state: ProcessingState): Promise<void> {
  try {
    const command = new PutCommand({
      TableName: PROCESSING_STATE_TABLE,
      Item: state,
    });

    await retry(
      () => document.send(command),
      createRetryConfig(),
      'updateProcessingState'
    );

    logger.debug('Processing state updated', { 
      lastProcessingTime: state.lastProcessingTime,
      consecutiveSkips: state.consecutiveSkips,
    });

  } catch (error) {
    // Don't fail the entire process if state update fails
    logger.warn('Failed to update processing state', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Make scaling decision based on queue metrics and processing state
 */
function makeScalingDecision(
  queueMetrics: ProcessingMetrics,
  processingState: ProcessingState
): EC2ScalingDecision {
  const now = Date.now();
  const queueDepth = queueMetrics.queueDepth;
  const lastProcessingTime = processingState.lastProcessingTime;
  
  // Calculate time since last processing run
  const timeSinceLastRun = now - lastProcessingTime;
  const hoursSinceLastRun = timeSinceLastRun / (1000 * 60 * 60);
  const minutesSinceLastRun = timeSinceLastRun / (1000 * 60);

  logger.debug('Scaling decision factors', {
    queueDepth,
    hoursSinceLastRun,
    minutesSinceLastRun,
    batchThreshold: PROCESSING_THRESHOLDS.BATCH_THRESHOLD,
    maxWaitHours: PROCESSING_THRESHOLDS.MAX_WAIT_HOURS,
  });

  // Decision logic implementation
  let shouldScale = false;
  let reason = '';
  let desiredCapacity = 0;

  if (queueDepth === 0) {
    reason = 'Queue is empty';
  } else if (queueDepth >= PROCESSING_THRESHOLDS.BATCH_THRESHOLD) {
    shouldScale = true;
    reason = `Queue depth (${queueDepth}) exceeds batch threshold (${PROCESSING_THRESHOLDS.BATCH_THRESHOLD})`;
    desiredCapacity = calculateDesiredCapacity(queueDepth);
  } else if (queueDepth > 0 && hoursSinceLastRun > PROCESSING_THRESHOLDS.MAX_WAIT_HOURS) {
    shouldScale = true;
    reason = `Queue has items (${queueDepth}) and last processing was ${hoursSinceLastRun.toFixed(1)} hours ago`;
    desiredCapacity = calculateDesiredCapacity(queueDepth);
  } else if (queueDepth > 0 && minutesSinceLastRun < PROCESSING_THRESHOLDS.MIN_PROCESSING_INTERVAL_MINUTES) {
    reason = `Queue has items (${queueDepth}) but last processing was only ${minutesSinceLastRun.toFixed(1)} minutes ago`;
  } else {
    reason = `Queue depth (${queueDepth}) below threshold, waiting for more items or time`;
  }

  return {
    shouldScale,
    desiredCapacity,
    reason,
    currentCapacity: 0, // Will be filled by EC2 controller
    queueDepth,
  };
}

/**
 * Calculate desired EC2 capacity based on queue depth
 */
function calculateDesiredCapacity(queueDepth: number): number {
  const capacityMap = [
    { max: 50, instances: 1 },
    { max: 100, instances: 2 },
    { max: 200, instances: 3 },
    { max: Infinity, instances: 5 }
  ];
  
  const config = capacityMap.find(c => queueDepth <= c.max);
  return config?.instances || 1;
}

/**
 * Publish queue metrics to CloudWatch
 */
async function publishQueueMetrics(
  queueMetrics: ProcessingMetrics,
  scalingDecision: EC2ScalingDecision
): Promise<void> {
  try {
    const now = new Date();
    
    // Publish multiple metrics in parallel
    await Promise.all([
      // Queue depth metric
      awsClients.publishMetric(
        'iSync/QueueManager',
        'QueueDepth',
        queueMetrics.queueDepth,
        'Count',
        [{ Name: 'Environment', Value: config.nodeEnv }]
      ),
      
      // Processing triggered metric (0 or 1)
      awsClients.publishMetric(
        'iSync/QueueManager', 
        'ProcessingTriggered',
        scalingDecision.shouldScale ? 1 : 0,
        'Count',
        [{ Name: 'Environment', Value: config.nodeEnv }]
      ),
      
      // Time since last run metric (in seconds)
      awsClients.publishMetric(
        'iSync/QueueManager',
        'TimeSinceLastRun',
        (now.getTime() - queueMetrics.lastProcessingTime) / 1000,
        'Seconds',
        [{ Name: 'Environment', Value: config.nodeEnv }]
      ),
    ]);

    logger.debug('Queue metrics published to CloudWatch');

  } catch (error) {
    // Don't fail the entire process if metrics publishing fails
    logger.warn('Failed to publish queue metrics', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Invoke EC2 controller Lambda function to scale instances
 */
async function invokeEC2Controller(scalingDecision: EC2ScalingDecision): Promise<void> {
  try {
    const lambdaClient = new LambdaClient({
      region: config.region,
    });

    const payload = {
      action: 'scale',
      queueDepth: scalingDecision.queueDepth,
      desiredCapacity: scalingDecision.desiredCapacity,
      reason: scalingDecision.reason,
      timestamp: Date.now(),
    };

    const command = new InvokeCommand({
      FunctionName: `${process.env.FUNCTION_PREFIX || 'isync'}-ec2-controller`,
      InvocationType: 'RequestResponse',
      Payload: JSON.stringify(payload),
    });

    const response = await retry(
      () => lambdaClient.send(command),
      createRetryConfig(),
      'invokeEC2Controller'
    );

    if (response.FunctionError) {
      throw new Error(`EC2 controller returned error: ${response.FunctionError}`);
    }

    logger.info('EC2 controller invoked successfully', {
      desiredCapacity: scalingDecision.desiredCapacity,
      queueDepth: scalingDecision.queueDepth,
    });

  } catch (error) {
    throw new AWSServiceError(
      'Lambda',
      ErrorCode.LAMBDA_ERROR,
      `Failed to invoke EC2 controller: ${error instanceof Error ? error.message : String(error)}`,
      true,
      error as Error
    );
  }
}