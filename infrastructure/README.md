# iSync Infrastructure

This directory contains the complete Infrastructure as Code (IaC) configuration for the iSync Local File Loader project using Terraform.

## Architecture Overview

The infrastructure is designed as a serverless, cost-optimized solution within AWS free tier limits:

- **API Gateway**: RESTful API endpoints
- **Lambda Functions**: Serverless compute for all processing
- **S3**: Music file storage with lifecycle policies
- **DynamoDB**: Metadata storage with GSI for efficient queries
- **SQS**: Message queuing with dead letter queue
- **EventBridge**: Scheduled processing triggers
- **EC2 Auto Scaling**: On-demand iTunes automation instances
- **CloudWatch**: Comprehensive monitoring and alerting

## Directory Structure

```
infrastructure/
├── terraform/
│   ├── main.tf              # Root configuration
│   ├── variables.tf         # Input variables
│   ├── outputs.tf           # Output values
│   └── modules/
│       ├── api/             # API Gateway configuration
│       ├── compute/         # Lambda functions and EC2
│       ├── ec2/             # Auto Scaling Group and Launch Template
│       ├── messaging/       # SQS and EventBridge
│       ├── monitoring/      # CloudWatch and X-Ray
│       └── storage/         # S3 and DynamoDB
└── scripts/
    ├── deploy.sh            # Main deployment script
    └── validate.sh          # Infrastructure validation
```

## Prerequisites

1. **AWS CLI** configured with appropriate credentials
2. **Terraform** >= 1.5
3. **AWS Account** with sufficient permissions
4. **S3 Bucket** for Terraform state (created during setup)

## Quick Start

1. **Clone and navigate to infrastructure directory:**
   ```bash
   cd infrastructure/terraform
   ```

2. **Initialize Terraform:**
   ```bash
   terraform init
   ```

3. **Plan deployment:**
   ```bash
   terraform plan -var="environment=prod"
   ```

4. **Deploy infrastructure:**
   ```bash
   terraform apply -var="environment=prod"
   ```

## Using Deployment Scripts

### Deploy Infrastructure
```bash
./scripts/deploy.sh [environment]
```

### Validate Deployment
```bash
./scripts/validate.sh [environment]
```

### Plan Only
```bash
./scripts/deploy.sh plan
```

### Destroy Infrastructure
```bash
./scripts/deploy.sh destroy
```

## Configuration Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `aws_region` | `us-east-1` | AWS region for deployment |
| `environment` | `prod` | Environment name (dev/staging/prod) |
| `ec2_instance_type` | `t2.micro` | EC2 instance type for processing |
| `lambda_memory_size` | `512` | Lambda function memory in MB |
| `lambda_timeout` | `30` | Lambda function timeout in seconds |
| `retention_days` | `14` | CloudWatch logs retention period |

## Environments

- **Development**: `terraform workspace select dev`
- **Staging**: `terraform workspace select staging`
- **Production**: `terraform workspace select prod`

## Security Features

### Data Protection
- **S3**: Server-side encryption (AES-256), versioning enabled
- **DynamoDB**: Encryption at rest, point-in-time recovery
- **Lambda**: Environment variables encryption
- **API Gateway**: HTTPS only, CORS configured

### Access Control
- **IAM**: Least privilege roles and policies
- **S3**: Public access blocked
- **Security Groups**: Minimal required access
- **Secrets Manager**: Secure credential storage

### Monitoring
- **CloudWatch**: Comprehensive metrics and alarms
- **X-Ray**: Distributed tracing enabled
- **VPC Flow Logs**: Network traffic monitoring
- **CloudTrail**: API call logging

## Cost Optimization

### Free Tier Utilization
- **Lambda**: 1M requests, 400,000 GB-seconds
- **S3**: 5GB storage, 20,000 GET, 2,000 PUT requests
- **DynamoDB**: 25GB storage, 25 RCU/WCU
- **EC2**: 750 hours t2.micro
- **API Gateway**: 1M calls (first 12 months)

### Lifecycle Policies
- **S3**: Automatic cleanup of failed uploads (30 days)
- **S3**: Processed files retention (90 days)
- **CloudWatch**: Log retention (14 days)
- **DynamoDB**: TTL for expired records

### Auto Scaling
- **EC2**: Scale from 0 to 2 instances based on queue depth
- **Lambda**: Automatic scaling with provisioned concurrency options
- **DynamoDB**: On-demand billing mode

## Monitoring and Alerting

### CloudWatch Dashboard
- Lambda function metrics (duration, errors, invocations)
- SQS queue depth and message processing
- API Gateway latency and error rates
- DynamoDB read/write capacity and throttles

### Alarms
- **Lambda Errors**: > 5 errors in 10 minutes
- **Lambda Duration**: > 25 seconds average
- **API 4XX Errors**: > 10 errors in 10 minutes
- **API 5XX Errors**: > 2 errors in 10 minutes
- **Queue Depth**: > 10 messages for scaling
- **DynamoDB Throttles**: Any throttled requests

### X-Ray Tracing
- End-to-end request tracing
- Performance bottleneck identification
- Error root cause analysis

## Troubleshooting

### Common Issues

1. **Terraform State Lock**
   ```bash
   terraform force-unlock LOCK_ID
   ```

2. **AWS Credentials**
   ```bash
   aws configure list
   aws sts get-caller-identity
   ```

3. **Resource Limits**
   - Check AWS service quotas
   - Verify free tier usage

4. **Lambda Deployment Package**
   - Ensure ZIP files exist in correct paths
   - Check file permissions and sizes

### Validation Commands

```bash
# Check S3 bucket
aws s3 ls s3://isync-music-{account-id}

# Check DynamoDB table
aws dynamodb describe-table --table-name isync-upload-queue-prod

# Check Lambda functions
aws lambda list-functions --query 'Functions[?starts_with(FunctionName, `isync`)].FunctionName'

# Check API Gateway
aws apigateway get-rest-apis --query 'items[?name==`isync-api-prod`]'
```

## Outputs

After successful deployment, the following outputs are available:

- **API Endpoint**: HTTPS URL for the REST API
- **S3 Bucket**: Music file storage bucket name
- **DynamoDB Table**: Upload metadata table name
- **SQS Queue**: Processing queue URL
- **CloudWatch Dashboard**: Monitoring dashboard URL

## Next Steps

1. **Deploy Lambda Code**: Package and deploy function code
2. **Frontend Configuration**: Update API endpoint in frontend
3. **Testing**: Run end-to-end functionality tests
4. **CI/CD**: Set up GitHub Actions workflow
5. **Monitoring**: Configure SNS notifications

## Best Practices

### Development Workflow
1. Always use workspaces for different environments
2. Run `terraform plan` before applying changes
3. Use consistent naming conventions
4. Tag all resources appropriately
5. Document any manual changes

### Security
1. Never commit secrets to version control
2. Use AWS Secrets Manager for sensitive data
3. Regularly rotate access keys
4. Enable CloudTrail in all regions
5. Review IAM policies periodically

### Cost Management
1. Monitor AWS billing dashboard
2. Set up billing alerts
3. Use AWS Cost Explorer
4. Review resource utilization monthly
5. Implement proper tagging strategy

## Support

For issues and questions:
1. Check CloudWatch logs for error details
2. Review AWS service health dashboard
3. Consult AWS documentation
4. Create GitHub issue for project-specific problems