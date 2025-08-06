/**
 * Centralized AWS client configuration with optimizations for Lambda
 * Implements singleton pattern and connection reuse
 */

import { 
  S3Client, 
  GetObjectCommand, 
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { 
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand as DocQueryCommand,
  ScanCommand as DocScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { 
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { 
  EC2Client,
  DescribeInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeImagesCommand,
} from '@aws-sdk/client-ec2';
import { 
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  UpdateAutoScalingGroupCommand,
  SetDesiredCapacityCommand,
} from '@aws-sdk/client-auto-scaling';
import { 
  CloudWatchClient,
  PutMetricDataCommand,
  GetMetricStatisticsCommand,
  StandardUnit,
} from '@aws-sdk/client-cloudwatch';
import logger from './logger';

interface ClientConfig {
  region: string;
  maxAttempts: number;
  requestTimeout: number;
}

class AWSClients {
  private static instance: AWSClients;
  private config: ClientConfig;
  
  private _s3Client?: S3Client;
  private _dynamodbClient?: DynamoDBClient;
  private _documentClient?: DynamoDBDocumentClient;
  private _sqsClient?: SQSClient;
  private _ec2Client?: EC2Client;
  private _autoScalingClient?: AutoScalingClient;
  private _cloudWatchClient?: CloudWatchClient;

  private constructor() {
    this.config = {
      region: process.env.AWS_REGION || 'us-east-1',
      maxAttempts: 3,
      requestTimeout: 30000,
    };

    logger.debug('AWS clients initialized', {
      region: this.config.region,
      maxAttempts: this.config.maxAttempts,
      requestTimeout: this.config.requestTimeout,
    });
  }

  public static getInstance(): AWSClients {
    if (!AWSClients.instance) {
      AWSClients.instance = new AWSClients();
    }
    return AWSClients.instance;
  }

  private getBaseConfig() {
    return {
      region: this.config.region,
      maxAttempts: this.config.maxAttempts,
      requestHandler: {
        requestTimeout: this.config.requestTimeout,
      },
    };
  }

  get s3(): S3Client {
    if (!this._s3Client) {
      this._s3Client = new S3Client({
        ...this.getBaseConfig(),
        // Optimize for Lambda cold starts
        forcePathStyle: false,
        useAccelerateEndpoint: false,
      });
    }
    return this._s3Client;
  }

  get dynamodb(): DynamoDBClient {
    if (!this._dynamodbClient) {
      this._dynamodbClient = new DynamoDBClient(this.getBaseConfig());
    }
    return this._dynamodbClient;
  }

  get document(): DynamoDBDocumentClient {
    if (!this._documentClient) {
      this._documentClient = DynamoDBDocumentClient.from(this.dynamodb, {
        marshallOptions: {
          convertEmptyValues: false,
          removeUndefinedValues: true,
          convertClassInstanceToMap: false,
        },
        unmarshallOptions: {
          wrapNumbers: false,
        },
      });
    }
    return this._documentClient;
  }

  get sqs(): SQSClient {
    if (!this._sqsClient) {
      this._sqsClient = new SQSClient(this.getBaseConfig());
    }
    return this._sqsClient;
  }

  get ec2(): EC2Client {
    if (!this._ec2Client) {
      this._ec2Client = new EC2Client(this.getBaseConfig());
    }
    return this._ec2Client;
  }

  get autoScaling(): AutoScalingClient {
    if (!this._autoScalingClient) {
      this._autoScalingClient = new AutoScalingClient(this.getBaseConfig());
    }
    return this._autoScalingClient;
  }

  get cloudWatch(): CloudWatchClient {
    if (!this._cloudWatchClient) {
      this._cloudWatchClient = new CloudWatchClient(this.getBaseConfig());
    }
    return this._cloudWatchClient;
  }

  /**
   * Generate presigned URL for S3 upload
   */
  async generatePresignedUrl(
    bucket: string, 
    key: string, 
    expiresIn: number = 3600,
    contentType?: string
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });

    return logger.timeAsync('generatePresignedUrl', async () => {
      return await getSignedUrl(this.s3, command, { expiresIn });
    }, { bucket, key, expiresIn });
  }

  /**
   * Publish CloudWatch metric
   */
  async publishMetric(
    namespace: string,
    metricName: string,
    value: number,
    unit: StandardUnit = StandardUnit.Count,
    dimensions?: Array<{ Name: string; Value: string }>
  ): Promise<void> {
    const command = new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: [
        {
          MetricName: metricName,
          Value: value,
          Unit: unit,
          Timestamp: new Date(),
          Dimensions: dimensions,
        },
      ],
    });

    await logger.timeAsync('publishMetric', async () => {
      await this.cloudWatch.send(command);
    }, { namespace, metricName, value });
  }

  /**
   * Shutdown all clients (useful for testing)
   */
  destroy(): void {
    this._s3Client?.destroy();
    this._dynamodbClient?.destroy();
    this._sqsClient?.destroy();
    this._ec2Client?.destroy();
    this._autoScalingClient?.destroy();
    this._cloudWatchClient?.destroy();
    
    // Reset clients
    this._s3Client = undefined;
    this._dynamodbClient = undefined;
    this._documentClient = undefined;
    this._sqsClient = undefined;
    this._ec2Client = undefined;
    this._autoScalingClient = undefined;
    this._cloudWatchClient = undefined;

    logger.debug('AWS clients destroyed');
  }
}

// Export singleton instance
export const awsClients = AWSClients.getInstance();

// Export individual clients for convenience
export const s3 = awsClients.s3;
export const dynamodb = awsClients.dynamodb;
export const document = awsClients.document;
export const sqs = awsClients.sqs;
export const ec2 = awsClients.ec2;
export const autoScaling = awsClients.autoScaling;
export const cloudWatch = awsClients.cloudWatch;

// Export AWS command types for convenience
export {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  DocQueryCommand as QueryCommand,
  DocScanCommand as ScanCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  DescribeInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeAutoScalingGroupsCommand,
  UpdateAutoScalingGroupCommand,
  SetDesiredCapacityCommand,
  PutMetricDataCommand,
};

export default awsClients;