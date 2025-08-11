/**
 * EC2 Controller Lambda Function
 * 
 * Modified EC2 Controller to manage VM instances via Auto Scaling Group
 * Uses ASG desired capacity to start/stop instances with new AMI
 */

import { Context, Callback, Handler } from 'aws-lambda';
import { 
  EC2Client, 
  DescribeInstancesCommand 
} from '@aws-sdk/client-ec2';
import {
  AutoScalingClient,
  SetDesiredCapacityCommand,
  DescribeAutoScalingGroupsCommand
} from '@aws-sdk/client-auto-scaling';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { awsClients, ec2 } from '@shared/aws-clients';
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

// Lambda configuration
const config = getLambdaConfig();

// Create AWS clients
const sqsClient = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const autoScalingClient = new AutoScalingClient({ region: process.env.AWS_REGION || 'us-east-1' });

// VM configuration
const VM_CONFIG = {
  ASG_NAME: process.env.ASG_NAME || 'isync-processing-asg-prod',
  QUEUE_URL: process.env.SQS_QUEUE_URL || 'https://sqs.us-east-1.amazonaws.com/851725521369/isync-upload-queue-prod',
  INSTANCE_TYPE_COST: 0.0116, // t2.micro hourly cost in USD
} as const;

interface EC2ControllerEvent {
  action: 'START' | 'STOP' | 'STATUS';
  source?: string; // 'upload' or 'timer'
}

interface EC2Response {
  statusCode: number;
  instanceId?: string;
  state?: string;
  publicIp?: string;
  message: string;
  queueDepth?: number;
  willShutdownIn?: string;
  desiredCapacity?: number;
  runningInstances?: number;
}

/**
 * Main Lambda handler for EC2 operations
 */
export const handler: Handler<EC2ControllerEvent, EC2Response> = async (
  event: EC2ControllerEvent,
  context: Context,
  callback?: Callback<EC2Response>
) => {
  const requestId = getRequestId(context);
  
  logger.setContext({
    requestId,
    functionName: context.functionName,
  });

  logger.info('EC2 controller invoked', {
    action: event.action,
    source: event.source,
  });

  try {
    // Get current ASG status
    const asgStatus = await getASGStatus();
    
    logger.info(`Current ASG status: ${asgStatus.desiredCapacity} desired, ${asgStatus.runningInstances} running`);

    let response: EC2Response;

    switch (event.action) {
      case 'START':
        response = await handleStartRequest(event, asgStatus);
        break;
      case 'STOP':
        response = await handleStopRequest(asgStatus);
        break;
      case 'STATUS':
        response = await handleStatusRequest(asgStatus);
        break;
      default:
        throw new iSyncError(
          ErrorCode.VALIDATION_ERROR,
          `Invalid action: ${event.action}. Supported actions: START, STOP, STATUS`,
          400
        );
    }

    // Publish success metrics
    try {
      await awsClients.publishMetric(
        'iSync/EC2Controller',
        'OperationSuccess',
        1,
        'Count',
        [
          { Name: 'Environment', Value: config.nodeEnv },
          { Name: 'Action', Value: event.action },
        ]
      );
    } catch (metricsError) {
      logger.warn('Failed to publish success metrics', { metricsError });
    }

    logger.info('EC2 controller operation completed', {
      action: event.action,
      statusCode: response.statusCode,
      desiredCapacity: response.desiredCapacity,
      runningInstances: response.runningInstances,
    });

    if (callback) {
      callback(null, response);
    }
    return response;

  } catch (error) {
    logger.error('EC2 controller operation failed', error, { requestId });
    
    // Publish failure metrics
    try {
      await awsClients.publishMetric(
        'iSync/EC2Controller',
        'OperationFailed',
        1,
        'Count',
        [
          { Name: 'Environment', Value: config.nodeEnv },
          { Name: 'Action', Value: event.action || 'unknown' },
          { Name: 'ErrorType', Value: error instanceof Error ? error.constructor.name : 'Unknown' },
        ]
      );
    } catch (metricsError) {
      logger.warn('Failed to publish failure metrics', { metricsError });
    }

    const errorResponse: EC2Response = {
      statusCode: error instanceof iSyncError ? error.statusCode : 500,
      message: error instanceof Error ? error.message : String(error),
    };

    if (callback) {
      callback(null, errorResponse);
    }
    return errorResponse;
  } finally {
    logger.clearContext();
  }
};

/**
 * Handle VM start request via Auto Scaling Group
 */
async function handleStartRequest(
  event: EC2ControllerEvent, 
  asgStatus: any
): Promise<EC2Response> {
  // Check if there are messages in queue
  const queueAttributes = await sqsClient.send(new GetQueueAttributesCommand({
    QueueUrl: VM_CONFIG.QUEUE_URL,
    AttributeNames: ['ApproximateNumberOfMessages']
  }));
  
  const messageCount = parseInt(queueAttributes.Attributes?.ApproximateNumberOfMessages || '0');
  logger.info(`Queue has ${messageCount} messages`);

  if (asgStatus.desiredCapacity === 0) {
    if (messageCount > 0 || event.source === 'upload') {
      // Start an instance by setting desired capacity to 1
      const setCapacityCommand = new SetDesiredCapacityCommand({
        AutoScalingGroupName: VM_CONFIG.ASG_NAME,
        DesiredCapacity: 1,
        HonorCooldown: false
      });
      await autoScalingClient.send(setCapacityCommand);
      
      logger.info('ASG desired capacity set to 1 - instance will launch');
      
      // The new instance will automatically:
      // 1. Boot Windows with new AMI
      // 2. Start processor via Scheduled Task
      // 3. Start shutdown timer via Scheduled Task
      // 4. Process all queued files
      // 5. Shutdown after 30 minutes
      
      return {
        statusCode: 200,
        state: 'launching',
        message: 'VM launch initiated via Auto Scaling Group',
        queueDepth: messageCount,
        desiredCapacity: 1,
        runningInstances: asgStatus.runningInstances,
        willShutdownIn: '30 minutes after boot'
      };
    } else {
      return {
        statusCode: 200,
        state: 'stopped',
        message: 'No files to process, VM not started',
        queueDepth: messageCount,
        desiredCapacity: 0,
        runningInstances: 0
      };
    }
  } else if (asgStatus.runningInstances > 0) {
    // VM already running
    return {
      statusCode: 200,
      state: 'running',
      message: 'VM already running',
      queueDepth: messageCount,
      desiredCapacity: asgStatus.desiredCapacity,
      runningInstances: asgStatus.runningInstances,
      instanceId: asgStatus.instanceIds?.[0]
    };
  } else {
    return {
      statusCode: 200,
      state: 'pending',
      message: 'VM is launching',
      queueDepth: messageCount,
      desiredCapacity: asgStatus.desiredCapacity,
      runningInstances: asgStatus.runningInstances
    };
  }
}

/**
 * Handle VM stop request via Auto Scaling Group
 */
async function handleStopRequest(asgStatus: any): Promise<EC2Response> {
  if (asgStatus.desiredCapacity > 0) {
    // Stop instances by setting desired capacity to 0
    const setCapacityCommand = new SetDesiredCapacityCommand({
      AutoScalingGroupName: VM_CONFIG.ASG_NAME,
      DesiredCapacity: 0,
      HonorCooldown: false
    });
    await autoScalingClient.send(setCapacityCommand);
    
    return {
      statusCode: 200,
      state: 'stopping',
      message: 'VM termination initiated via Auto Scaling Group',
      desiredCapacity: 0,
      runningInstances: asgStatus.runningInstances
    };
  } else {
    return {
      statusCode: 200,
      state: 'stopped',
      message: 'VM is already stopped',
      desiredCapacity: 0,
      runningInstances: asgStatus.runningInstances
    };
  }
}

/**
 * Handle status request for Auto Scaling Group
 */
async function handleStatusRequest(asgStatus: any): Promise<EC2Response> {
  const state = asgStatus.runningInstances > 0 ? 'running' : 
                asgStatus.desiredCapacity > 0 ? 'launching' : 'stopped';
  
  return {
    statusCode: 200,
    state,
    message: `ASG: ${asgStatus.desiredCapacity} desired, ${asgStatus.runningInstances} running`,
    desiredCapacity: asgStatus.desiredCapacity,
    runningInstances: asgStatus.runningInstances,
    instanceId: asgStatus.instanceIds?.[0],
    publicIp: asgStatus.publicIps?.[0]
  };
}

/**
 * Get current Auto Scaling Group status
 */
async function getASGStatus(): Promise<{
  desiredCapacity: number;
  runningInstances: number;
  instanceIds?: string[];
  publicIps?: string[];
}> {
  try {
    // Get ASG information
    const asgCommand = new DescribeAutoScalingGroupsCommand({
      AutoScalingGroupNames: [VM_CONFIG.ASG_NAME]
    });

    const asgResponse = await retry(
      () => autoScalingClient.send(asgCommand),
      createRetryConfig(),
      'describeAutoScalingGroups'
    );

    const asg = asgResponse.AutoScalingGroups?.[0];
    
    if (!asg) {
      throw new AWSServiceError(
        'AutoScaling',
        ErrorCode.EC2_ERROR,
        `Auto Scaling Group ${VM_CONFIG.ASG_NAME} not found`,
        false
      );
    }

    const desiredCapacity = asg.DesiredCapacity || 0;
    const runningInstances = asg.Instances?.filter(i => i.LifecycleState === 'InService').length || 0;
    const instanceIds = asg.Instances?.filter(i => i.LifecycleState === 'InService').map(i => i.InstanceId).filter(Boolean) as string[];

    let publicIps: string[] = [];
    
    // Get public IPs if there are running instances
    if (instanceIds && instanceIds.length > 0) {
      try {
        const ec2Command = new DescribeInstancesCommand({
          InstanceIds: instanceIds
        });
        
        const ec2Response = await retry(
          () => ec2.send(ec2Command),
          createRetryConfig(),
          'describeInstances'
        );

        publicIps = ec2Response.Reservations?.flatMap(r => 
          r.Instances?.map(i => i.PublicIpAddress).filter(Boolean) || []
        ) as string[] || [];
      } catch (ec2Error) {
        logger.warn('Failed to get instance public IPs', { ec2Error });
      }
    }

    return {
      desiredCapacity,
      runningInstances,
      instanceIds,
      publicIps
    };

  } catch (error) {
    throw new AWSServiceError(
      'AutoScaling',
      ErrorCode.EC2_ERROR,
      `Failed to describe Auto Scaling Group: ${error instanceof Error ? error.message : String(error)}`,
      true,
      error as Error
    );
  }
}