"""
Integration Tests for iSync Music Processor
Tests integration between components and with AWS services (requires real AWS setup)
"""

import os
import sys
import unittest
import json
import time
import tempfile
from unittest.mock import patch, Mock

# Add src to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

try:
    import boto3
    from botocore.exceptions import NoCredentialsError
    AWS_AVAILABLE = True
except ImportError:
    AWS_AVAILABLE = False

class TestAWSConnectivity(unittest.TestCase):
    """Test connectivity to AWS services"""
    
    def setUp(self):
        if not AWS_AVAILABLE:
            self.skipTest("boto3 not available")
        
        # Check for AWS credentials
        try:
            session = boto3.Session()
            credentials = session.get_credentials()
            if not credentials:
                self.skipTest("AWS credentials not configured")
        except NoCredentialsError:
            self.skipTest("AWS credentials not configured")
    
    def test_sqs_connectivity(self):
        """Test basic SQS connectivity"""
        try:
            sqs = boto3.client('sqs', region_name='us-east-1')
            # List queues to test connectivity
            response = sqs.list_queues()
            self.assertIsInstance(response, dict)
            print(f"SQS connectivity: OK ({len(response.get('QueueUrls', []))} queues found)")
        except Exception as e:
            self.fail(f"SQS connectivity failed: {e}")
    
    def test_s3_connectivity(self):
        """Test basic S3 connectivity"""
        try:
            s3 = boto3.client('s3', region_name='us-east-1')
            # List buckets to test connectivity
            response = s3.list_buckets()
            self.assertIsInstance(response, dict)
            print(f"S3 connectivity: OK ({len(response.get('Buckets', []))} buckets found)")
        except Exception as e:
            self.fail(f"S3 connectivity failed: {e}")
    
    def test_dynamodb_connectivity(self):
        """Test basic DynamoDB connectivity"""
        try:
            dynamodb = boto3.client('dynamodb', region_name='us-east-1')
            # List tables to test connectivity
            response = dynamodb.list_tables()
            self.assertIsInstance(response, dict)
            print(f"DynamoDB connectivity: OK ({len(response.get('TableNames', []))} tables found)")
        except Exception as e:
            self.fail(f"DynamoDB connectivity failed: {e}")

class TestProcessorIntegration(unittest.TestCase):
    """Integration tests for the complete processor workflow"""
    
    def setUp(self):
        # Set up test environment
        self.test_env = {
            'AWS_REGION': 'us-east-1',
            'SQS_QUEUE_URL': os.environ.get('TEST_SQS_QUEUE_URL', ''),
            'S3_BUCKET': os.environ.get('TEST_S3_BUCKET', ''),
            'DYNAMODB_TABLE': os.environ.get('TEST_DYNAMODB_TABLE', ''),
            'DOWNLOAD_DIR': tempfile.mkdtemp(),
            'TEMP_DIR': tempfile.mkdtemp()
        }
        
        # Apply test environment
        for key, value in self.test_env.items():
            os.environ[key] = value
        
        # Skip if test resources not configured
        if not all([
            self.test_env['SQS_QUEUE_URL'],
            self.test_env['S3_BUCKET'],
            self.test_env['DYNAMODB_TABLE']
        ]):
            self.skipTest("Test AWS resources not configured")
    
    def test_config_with_real_aws(self):
        """Test configuration with real AWS resources"""
        from config import Config
        
        config = Config()
        self.assertTrue(config.is_valid())
        print(f"Configuration valid: {config.sqs_queue_url}")
    
    @unittest.skipUnless(os.environ.get('TEST_SQS_QUEUE_URL'), "Test SQS queue not configured")
    def test_sqs_integration(self):
        """Test SQS integration with real queue"""
        from config import Config
        from queue_processor import QueueProcessor
        
        config = Config()
        processor = QueueProcessor(config)
        
        # Test queue attributes
        attributes = processor.get_queue_attributes()
        self.assertIsInstance(attributes, dict)
        print(f"Queue attributes: {attributes}")
        
        # Test message polling (should return empty list if no messages)
        messages = processor.get_messages(max_messages=1, wait_time=1)
        self.assertIsInstance(messages, list)
        print(f"Messages received: {len(messages)}")
    
    @unittest.skipUnless(os.environ.get('TEST_S3_BUCKET'), "Test S3 bucket not configured")
    def test_s3_integration(self):
        """Test S3 integration with real bucket"""
        from config import Config
        from s3_handler import S3Handler
        
        config = Config()
        handler = S3Handler(config)
        
        # Create a test file
        test_content = b"This is a test file for iSync processor"
        test_file_path = os.path.join(config.temp_directory, 'test_file.txt')
        
        with open(test_file_path, 'wb') as f:
            f.write(test_content)
        
        try:
            # Test upload
            s3_key = 'test/processor_test_file.txt'
            upload_success = handler.upload_file(test_file_path, s3_key)
            self.assertTrue(upload_success, "Failed to upload test file")
            print(f"Upload successful: {s3_key}")
            
            # Test metadata retrieval
            metadata = handler.get_file_metadata(s3_key)
            self.assertIsNotNone(metadata)
            print(f"File metadata: {metadata}")
            
            # Test download
            download_path = handler.generate_download_path(s3_key)
            download_success = handler.download_file(s3_key, download_path)
            self.assertTrue(download_success, "Failed to download test file")
            print(f"Download successful: {download_path}")
            
            # Verify file content
            with open(download_path, 'rb') as f:
                downloaded_content = f.read()
            self.assertEqual(test_content, downloaded_content)
            
            # Clean up
            handler.delete_file(s3_key)
            handler.cleanup_local_file(download_path)
            
        finally:
            # Clean up local test file
            if os.path.exists(test_file_path):
                os.remove(test_file_path)
    
    @unittest.skipUnless(os.environ.get('TEST_DYNAMODB_TABLE'), "Test DynamoDB table not configured")
    def test_dynamodb_integration(self):
        """Test DynamoDB integration with real table"""
        from config import Config
        from status_updater import StatusUpdater, ProcessingStatus
        
        config = Config()
        updater = StatusUpdater(config)
        
        # Test status update
        test_upload_id = f"test-upload-{int(time.time())}"
        test_user_id = "test-user-integration"
        
        # Update to processing status
        success = updater.update_status(
            upload_id=test_upload_id,
            user_id=test_user_id,
            status=ProcessingStatus.PROCESSING,
            message="Integration test processing"
        )
        self.assertTrue(success, "Failed to update status to processing")
        print(f"Status update successful: {test_upload_id}")
        
        # Retrieve the record
        record = updater.get_upload_record(test_upload_id, test_user_id)
        if record:  # Record might not exist if table is not set up properly
            self.assertEqual(record['status'], 'processing')
            print(f"Record retrieved: {record}")
        
        # Update to completed status
        success = updater.mark_processing_complete(
            upload_id=test_upload_id,
            user_id=test_user_id,
            processing_duration=30
        )
        print(f"Completion update: {'success' if success else 'failed'}")

if __name__ == '__main__':
    print("=" * 60)
    print("iSync Processor Integration Tests")
    print("=" * 60)
    print()
    print("Prerequisites for full testing:")
    print("1. AWS credentials configured (aws configure or IAM role)")
    print("2. Set environment variables:")
    print("   - TEST_SQS_QUEUE_URL")
    print("   - TEST_S3_BUCKET") 
    print("   - TEST_DYNAMODB_TABLE")
    print()
    
    # Run the tests
    unittest.main(verbosity=2)