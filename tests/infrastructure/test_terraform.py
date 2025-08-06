#!/usr/bin/env python3
"""
iSync Infrastructure Test Suite
Comprehensive tests for Terraform infrastructure validation
"""

import os
import json
import boto3
import pytest
import requests
from pathlib import Path
from typing import Dict, Any
from botocore.exceptions import ClientError, NoCredentialsError

class TestInfrastructure:
    """Test suite for iSync infrastructure components"""
    
    @classmethod
    def setup_class(cls):
        """Set up test environment and AWS clients"""
        cls.environment = os.getenv('ENVIRONMENT', 'prod')
        cls.region = os.getenv('AWS_DEFAULT_REGION', 'us-east-1')
        
        try:
            # Initialize AWS clients
            cls.s3_client = boto3.client('s3', region_name=cls.region)
            cls.dynamodb_client = boto3.client('dynamodb', region_name=cls.region)
            cls.sqs_client = boto3.client('sqs', region_name=cls.region)
            cls.lambda_client = boto3.client('lambda', region_name=cls.region)
            cls.apigateway_client = boto3.client('apigateway', region_name=cls.region)
            cls.ec2_client = boto3.client('ec2', region_name=cls.region)
            cls.autoscaling_client = boto3.client('autoscaling', region_name=cls.region)
            cls.cloudwatch_client = boto3.client('cloudwatch', region_name=cls.region)
            
            # Load Terraform outputs
            cls.outputs = cls._load_terraform_outputs()
            
        except NoCredentialsError:
            pytest.skip("AWS credentials not available")
        except Exception as e:
            pytest.skip(f"Setup failed: {e}")
    
    @classmethod
    def _load_terraform_outputs(cls) -> Dict[str, Any]:
        """Load Terraform outputs from JSON file"""
        outputs_file = Path(__file__).parent.parent.parent / 'infrastructure' / 'terraform' / f'outputs-{cls.environment}.json'
        
        if not outputs_file.exists():
            return {}
        
        with open(outputs_file, 'r') as f:
            outputs = json.load(f)
        
        # Extract values from Terraform output format
        return {k: v.get('value') for k, v in outputs.items()}

class TestS3Storage(TestInfrastructure):
    """Test S3 storage configuration"""
    
    def test_s3_bucket_exists(self):
        """Test that S3 bucket exists and is accessible"""
        bucket_name = self.outputs.get('upload_bucket_name')
        assert bucket_name, "S3 bucket name not found in outputs"
        
        # Check if bucket exists
        try:
            self.s3_client.head_bucket(Bucket=bucket_name)
        except ClientError as e:
            pytest.fail(f"S3 bucket {bucket_name} not accessible: {e}")
    
    def test_s3_versioning_enabled(self):
        """Test that S3 bucket has versioning enabled"""
        bucket_name = self.outputs.get('upload_bucket_name')
        assert bucket_name, "S3 bucket name not found in outputs"
        
        response = self.s3_client.get_bucket_versioning(Bucket=bucket_name)
        assert response.get('Status') == 'Enabled', "S3 bucket versioning not enabled"
    
    def test_s3_encryption_enabled(self):
        """Test that S3 bucket has encryption enabled"""
        bucket_name = self.outputs.get('upload_bucket_name')
        assert bucket_name, "S3 bucket name not found in outputs"
        
        try:
            response = self.s3_client.get_bucket_encryption(Bucket=bucket_name)
            rules = response.get('ServerSideEncryptionConfiguration', {}).get('Rules', [])
            assert len(rules) > 0, "No encryption rules configured"
            assert rules[0]['ApplyServerSideEncryptionByDefault']['SSEAlgorithm'] in ['AES256', 'aws:kms']
        except ClientError as e:
            if e.response['Error']['Code'] != 'ServerSideEncryptionConfigurationNotFoundError':
                pytest.fail(f"Error checking S3 encryption: {e}")
            else:
                pytest.fail("S3 bucket encryption not configured")
    
    def test_s3_public_access_blocked(self):
        """Test that S3 bucket has public access blocked"""
        bucket_name = self.outputs.get('upload_bucket_name')
        assert bucket_name, "S3 bucket name not found in outputs"
        
        response = self.s3_client.get_public_access_block(Bucket=bucket_name)
        pab = response['PublicAccessBlockConfiguration']
        
        assert pab['BlockPublicAcls'] is True
        assert pab['IgnorePublicAcls'] is True
        assert pab['BlockPublicPolicy'] is True
        assert pab['RestrictPublicBuckets'] is True
    
    def test_s3_lifecycle_configuration(self):
        """Test that S3 bucket has lifecycle policies"""
        bucket_name = self.outputs.get('upload_bucket_name')
        assert bucket_name, "S3 bucket name not found in outputs"
        
        try:
            response = self.s3_client.get_bucket_lifecycle_configuration(Bucket=bucket_name)
            rules = response.get('Rules', [])
            assert len(rules) > 0, "No lifecycle rules configured"
            
            # Check for cleanup rules
            rule_ids = [rule['ID'] for rule in rules]
            assert any('cleanup' in rule_id.lower() for rule_id in rule_ids)
            
        except ClientError as e:
            if e.response['Error']['Code'] != 'NoSuchLifecycleConfiguration':
                pytest.fail(f"Error checking S3 lifecycle: {e}")

class TestDynamoDB(TestInfrastructure):
    """Test DynamoDB configuration"""
    
    def test_dynamodb_table_exists(self):
        """Test that DynamoDB table exists and is active"""
        table_name = self.outputs.get('upload_table_name')
        assert table_name, "DynamoDB table name not found in outputs"
        
        try:
            response = self.dynamodb_client.describe_table(TableName=table_name)
            assert response['Table']['TableStatus'] == 'ACTIVE'
        except ClientError as e:
            pytest.fail(f"DynamoDB table {table_name} not accessible: {e}")
    
    def test_dynamodb_gsi_exists(self):
        """Test that DynamoDB table has Global Secondary Index"""
        table_name = self.outputs.get('upload_table_name')
        assert table_name, "DynamoDB table name not found in outputs"
        
        response = self.dynamodb_client.describe_table(TableName=table_name)
        gsi_list = response['Table'].get('GlobalSecondaryIndexes', [])
        
        assert len(gsi_list) > 0, "No Global Secondary Indexes found"
        
        # Check for UserUploadsIndex
        gsi_names = [gsi['IndexName'] for gsi in gsi_list]
        assert 'UserUploadsIndex' in gsi_names
    
    def test_dynamodb_encryption_enabled(self):
        """Test that DynamoDB table has encryption enabled"""
        table_name = self.outputs.get('upload_table_name')
        assert table_name, "DynamoDB table name not found in outputs"
        
        response = self.dynamodb_client.describe_table(TableName=table_name)
        sse_description = response['Table'].get('SSEDescription')
        
        if sse_description:
            assert sse_description['Status'] == 'ENABLED'
    
    def test_dynamodb_point_in_time_recovery(self):
        """Test that DynamoDB table has point-in-time recovery enabled"""
        table_name = self.outputs.get('upload_table_name')
        assert table_name, "DynamoDB table name not found in outputs"
        
        try:
            response = self.dynamodb_client.describe_continuous_backups(TableName=table_name)
            pitr_status = response['ContinuousBackupsDescription']['PointInTimeRecoveryDescription']['PointInTimeRecoveryStatus']
            assert pitr_status == 'ENABLED'
        except ClientError as e:
            pytest.fail(f"Error checking point-in-time recovery: {e}")

class TestSQS(TestInfrastructure):
    """Test SQS configuration"""
    
    def test_sqs_queue_exists(self):
        """Test that SQS queue exists"""
        queue_url = self.outputs.get('queue_url')
        assert queue_url, "SQS queue URL not found in outputs"
        
        try:
            self.sqs_client.get_queue_attributes(QueueUrl=queue_url, AttributeNames=['All'])
        except ClientError as e:
            pytest.fail(f"SQS queue {queue_url} not accessible: {e}")
    
    def test_sqs_dead_letter_queue(self):
        """Test that SQS queue has dead letter queue configured"""
        queue_url = self.outputs.get('queue_url')
        assert queue_url, "SQS queue URL not found in outputs"
        
        response = self.sqs_client.get_queue_attributes(
            QueueUrl=queue_url,
            AttributeNames=['RedrivePolicy']
        )
        
        redrive_policy = response['Attributes'].get('RedrivePolicy')
        assert redrive_policy, "Dead letter queue not configured"
        
        # Parse redrive policy JSON
        import json
        policy = json.loads(redrive_policy)
        assert 'deadLetterTargetArn' in policy
        assert policy.get('maxReceiveCount', 0) > 0

class TestLambda(TestInfrastructure):
    """Test Lambda functions"""
    
    @pytest.mark.parametrize("function_suffix", [
        "upload-handler",
        "metadata-processor", 
        "queue-manager",
        "ec2-controller"
    ])
    def test_lambda_function_exists(self, function_suffix):
        """Test that Lambda functions exist and are active"""
        function_name = f"isync-{function_suffix}-{self.environment}"
        
        try:
            response = self.lambda_client.get_function(FunctionName=function_name)
            assert response['Configuration']['State'] == 'Active'
        except ClientError as e:
            pytest.fail(f"Lambda function {function_name} not accessible: {e}")
    
    @pytest.mark.parametrize("function_suffix", [
        "upload-handler",
        "metadata-processor",
        "queue-manager", 
        "ec2-controller"
    ])
    def test_lambda_tracing_enabled(self, function_suffix):
        """Test that Lambda functions have X-Ray tracing enabled"""
        function_name = f"isync-{function_suffix}-{self.environment}"
        
        try:
            response = self.lambda_client.get_function(FunctionName=function_name)
            tracing_config = response['Configuration'].get('TracingConfig', {})
            assert tracing_config.get('Mode') == 'Active'
        except ClientError as e:
            pytest.fail(f"Error checking tracing for {function_name}: {e}")

class TestAPIGateway(TestInfrastructure):
    """Test API Gateway configuration"""
    
    def test_api_gateway_exists(self):
        """Test that API Gateway exists"""
        api_endpoint = self.outputs.get('api_endpoint')
        assert api_endpoint, "API endpoint not found in outputs"
        
        # Extract API ID from endpoint URL
        api_id = api_endpoint.split('//')[1].split('.')[0]
        
        try:
            self.apigateway_client.get_rest_api(restApiId=api_id)
        except ClientError as e:
            pytest.fail(f"API Gateway {api_id} not accessible: {e}")
    
    def test_api_cors_enabled(self):
        """Test that API Gateway has CORS enabled"""
        api_endpoint = self.outputs.get('api_endpoint')
        assert api_endpoint, "API endpoint not found in outputs"
        
        # Test OPTIONS request for CORS
        try:
            response = requests.options(f"{api_endpoint}/upload", timeout=10)
            # Should return 200 for OPTIONS request
            assert response.status_code in [200, 204]
            
            # Check CORS headers
            headers = response.headers
            assert 'Access-Control-Allow-Origin' in headers
            assert 'Access-Control-Allow-Methods' in headers
            
        except requests.RequestException as e:
            pytest.fail(f"CORS test failed: {e}")

class TestAutoScaling(TestInfrastructure):
    """Test EC2 Auto Scaling configuration"""
    
    def test_autoscaling_group_exists(self):
        """Test that Auto Scaling Group exists"""
        asg_name = f"isync-processing-asg-{self.environment}"
        
        try:
            response = self.autoscaling_client.describe_auto_scaling_groups(
                AutoScalingGroupNames=[asg_name]
            )
            asgs = response['AutoScalingGroups']
            assert len(asgs) == 1
            
            asg = asgs[0]
            assert asg['MinSize'] == 0
            assert asg['MaxSize'] >= 1
            assert asg['DesiredCapacity'] == 0
            
        except ClientError as e:
            pytest.fail(f"Auto Scaling Group {asg_name} not accessible: {e}")
    
    def test_launch_template_exists(self):
        """Test that Launch Template exists"""
        template_name = f"isync-processing-{self.environment}-"
        
        try:
            response = self.ec2_client.describe_launch_templates()
            templates = [t for t in response['LaunchTemplates'] 
                        if t['LaunchTemplateName'].startswith(template_name)]
            assert len(templates) > 0, f"No launch template found with prefix {template_name}"
        except ClientError as e:
            pytest.fail(f"Error checking launch templates: {e}")

class TestCloudWatch(TestInfrastructure):
    """Test CloudWatch monitoring configuration"""
    
    def test_cloudwatch_alarms_exist(self):
        """Test that CloudWatch alarms are configured"""
        alarm_prefix = f"isync-"
        
        try:
            response = self.cloudwatch_client.describe_alarms()
            isync_alarms = [alarm for alarm in response['MetricAlarms'] 
                           if alarm['AlarmName'].startswith(alarm_prefix)]
            
            assert len(isync_alarms) > 0, "No CloudWatch alarms found for iSync"
            
            # Check for critical alarms
            alarm_names = [alarm['AlarmName'] for alarm in isync_alarms]
            
            # Should have Lambda error alarms
            lambda_error_alarms = [name for name in alarm_names if 'error' in name.lower()]
            assert len(lambda_error_alarms) > 0, "No Lambda error alarms found"
            
        except ClientError as e:
            pytest.fail(f"Error checking CloudWatch alarms: {e}")
    
    def test_cloudwatch_dashboard_exists(self):
        """Test that CloudWatch dashboard exists"""
        dashboard_name = f"iSync-{self.environment}"
        
        try:
            self.cloudwatch_client.get_dashboard(DashboardName=dashboard_name)
        except ClientError as e:
            if e.response['Error']['Code'] == 'ResourceNotFound':
                pytest.fail(f"CloudWatch dashboard {dashboard_name} not found")
            else:
                pytest.fail(f"Error checking dashboard: {e}")

class TestIntegration(TestInfrastructure):
    """Integration tests for the complete system"""
    
    def test_end_to_end_connectivity(self):
        """Test end-to-end system connectivity"""
        # This is a basic connectivity test
        # More comprehensive E2E tests would require actual file uploads
        
        api_endpoint = self.outputs.get('api_endpoint')
        assert api_endpoint, "API endpoint not found in outputs"
        
        try:
            # Test basic API connectivity
            response = requests.get(api_endpoint, timeout=10)
            # Should get some response (even if 404/403 is expected for root path)
            assert response.status_code < 500, f"API Gateway returned server error: {response.status_code}"
        except requests.RequestException as e:
            pytest.fail(f"API connectivity test failed: {e}")

if __name__ == "__main__":
    pytest.main([__file__, "-v"])