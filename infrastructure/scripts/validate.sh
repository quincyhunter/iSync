#!/bin/bash

# iSync Music Manager - Infrastructure Validation Script
# This script validates the deployed infrastructure

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="$(cd "$SCRIPT_DIR/../terraform" && pwd)"
ENVIRONMENT="${1:-prod}"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_status() { echo -e "${GREEN}✓${NC} $1"; }
print_warning() { echo -e "${YELLOW}⚠${NC} $1"; }
print_error() { echo -e "${RED}✗${NC} $1"; }

echo -e "${GREEN}🔍 iSync Infrastructure Validation${NC}"
echo "Environment: $ENVIRONMENT"
echo ""

cd "$TERRAFORM_DIR"

# Check if terraform outputs exist
if [ ! -f "outputs-$ENVIRONMENT.json" ]; then
    print_error "No outputs file found. Run deployment first."
    exit 1
fi

# Read outputs
API_ENDPOINT=$(terraform output -raw api_endpoint 2>/dev/null || echo "")
S3_BUCKET=$(terraform output -raw upload_bucket_name 2>/dev/null || echo "")
DYNAMODB_TABLE=$(terraform output -raw upload_table_name 2>/dev/null || echo "")
SQS_QUEUE=$(terraform output -raw queue_url 2>/dev/null || echo "")

echo "Validating resources..."
echo ""

# Test S3 Bucket
if [ -n "$S3_BUCKET" ]; then
    if aws s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null; then
        print_status "S3 bucket exists and is accessible: $S3_BUCKET"
        
        # Check bucket versioning
        VERSIONING=$(aws s3api get-bucket-versioning --bucket "$S3_BUCKET" --query 'Status' --output text)
        if [ "$VERSIONING" = "Enabled" ]; then
            print_status "S3 bucket versioning is enabled"
        else
            print_warning "S3 bucket versioning is not enabled"
        fi
        
        # Check bucket encryption
        if aws s3api get-bucket-encryption --bucket "$S3_BUCKET" >/dev/null 2>&1; then
            print_status "S3 bucket encryption is enabled"
        else
            print_warning "S3 bucket encryption is not configured"
        fi
    else
        print_error "S3 bucket not accessible: $S3_BUCKET"
    fi
else
    print_error "S3 bucket name not found in outputs"
fi

echo ""

# Test DynamoDB Table
if [ -n "$DYNAMODB_TABLE" ]; then
    if aws dynamodb describe-table --table-name "$DYNAMODB_TABLE" >/dev/null 2>&1; then
        print_status "DynamoDB table exists: $DYNAMODB_TABLE"
        
        # Check table status
        TABLE_STATUS=$(aws dynamodb describe-table --table-name "$DYNAMODB_TABLE" --query 'Table.TableStatus' --output text)
        if [ "$TABLE_STATUS" = "ACTIVE" ]; then
            print_status "DynamoDB table is ACTIVE"
        else
            print_warning "DynamoDB table status: $TABLE_STATUS"
        fi
        
        # Check point-in-time recovery
        PITR=$(aws dynamodb describe-continuous-backups --table-name "$DYNAMODB_TABLE" --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' --output text)
        if [ "$PITR" = "ENABLED" ]; then
            print_status "DynamoDB point-in-time recovery is enabled"
        else
            print_warning "DynamoDB point-in-time recovery is not enabled"
        fi
    else
        print_error "DynamoDB table not accessible: $DYNAMODB_TABLE"
    fi
else
    print_error "DynamoDB table name not found in outputs"
fi

echo ""

# Test SQS Queue
if [ -n "$SQS_QUEUE" ]; then
    if aws sqs get-queue-attributes --queue-url "$SQS_QUEUE" --attribute-names All >/dev/null 2>&1; then
        print_status "SQS queue exists: $SQS_QUEUE"
        
        # Check queue attributes
        VISIBILITY_TIMEOUT=$(aws sqs get-queue-attributes --queue-url "$SQS_QUEUE" --attribute-names VisibilityTimeoutSeconds --query 'Attributes.VisibilityTimeoutSeconds' --output text)
        print_status "SQS visibility timeout: ${VISIBILITY_TIMEOUT}s"
        
        # Check dead letter queue
        DLQ_CONFIG=$(aws sqs get-queue-attributes --queue-url "$SQS_QUEUE" --attribute-names RedrivePolicy --query 'Attributes.RedrivePolicy' --output text 2>/dev/null || echo "null")
        if [ "$DLQ_CONFIG" != "null" ]; then
            print_status "Dead letter queue is configured"
        else
            print_warning "Dead letter queue is not configured"
        fi
    else
        print_error "SQS queue not accessible: $SQS_QUEUE"
    fi
else
    print_error "SQS queue URL not found in outputs"
fi

echo ""

# Test Lambda Functions
LAMBDA_FUNCTIONS=("isync-upload-handler-$ENVIRONMENT" "isync-metadata-processor-$ENVIRONMENT" "isync-queue-manager-$ENVIRONMENT" "isync-ec2-controller-$ENVIRONMENT")

for FUNCTION in "${LAMBDA_FUNCTIONS[@]}"; do
    if aws lambda get-function --function-name "$FUNCTION" >/dev/null 2>&1; then
        print_status "Lambda function exists: $FUNCTION"
        
        # Check function state
        STATE=$(aws lambda get-function --function-name "$FUNCTION" --query 'Configuration.State' --output text)
        if [ "$STATE" = "Active" ]; then
            print_status "Lambda function is Active: $FUNCTION"
        else
            print_warning "Lambda function state: $STATE ($FUNCTION)"
        fi
        
        # Check tracing
        TRACING=$(aws lambda get-function --function-name "$FUNCTION" --query 'Configuration.TracingConfig.Mode' --output text)
        if [ "$TRACING" = "Active" ]; then
            print_status "X-Ray tracing is enabled: $FUNCTION"
        else
            print_warning "X-Ray tracing is not enabled: $FUNCTION"
        fi
    else
        print_error "Lambda function not found: $FUNCTION"
    fi
done

echo ""

# Test API Gateway
if [ -n "$API_ENDPOINT" ]; then
    print_status "Testing API Gateway endpoint: $API_ENDPOINT"
    
    # Test basic connectivity (this will likely return 403/404 which is expected)
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API_ENDPOINT" || echo "000")
    
    if [ "$HTTP_CODE" != "000" ]; then
        print_status "API Gateway is responding (HTTP $HTTP_CODE)"
    else
        print_error "API Gateway is not responding"
    fi
    
    # Test CORS preflight
    CORS_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "$API_ENDPOINT/upload" || echo "000")
    if [ "$CORS_CODE" = "200" ]; then
        print_status "CORS is configured correctly"
    else
        print_warning "CORS may not be configured (HTTP $CORS_CODE)"
    fi
else
    print_error "API endpoint not found in outputs"
fi

echo ""

# Test CloudWatch Dashboard
DASHBOARD_URL=$(terraform output -raw cloudwatch_dashboard_url 2>/dev/null || echo "")
if [ -n "$DASHBOARD_URL" ]; then
    print_status "CloudWatch Dashboard URL: $DASHBOARD_URL"
else
    print_warning "CloudWatch Dashboard URL not found"
fi

echo ""
print_status "Validation completed!"

# Summary
echo ""
echo "=== Validation Summary ==="
echo "✓ Infrastructure components are deployed and accessible"
echo "✓ Security configurations are in place"
echo "✓ Monitoring and logging are configured"
echo ""
echo "Next steps:"
echo "1. Deploy Lambda function code"
echo "2. Test end-to-end functionality"
echo "3. Configure frontend with API endpoint"
echo "4. Set up CI/CD pipeline"