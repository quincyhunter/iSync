"""
Component Tests for iSync Music Processor
Tests individual components without requiring full AWS/iTunes setup
"""

import os
import sys
import unittest
from unittest.mock import Mock, patch, MagicMock
import tempfile
import json

# Add src to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from config import Config
from queue_processor import QueueProcessor, ProcessingMessage
from s3_handler import S3Handler
from status_updater import StatusUpdater, ProcessingStatus

class TestConfig(unittest.TestCase):
    """Test configuration management"""
    
    def setUp(self):
        # Set test environment variables
        self.test_env = {
            'AWS_REGION': 'us-east-1',
            'SQS_QUEUE_URL': 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue',
            'S3_BUCKET': 'test-bucket',
            'DYNAMODB_TABLE': 'test-table'
        }
        
        # Apply test environment
        for key, value in self.test_env.items():
            os.environ[key] = value
    
    def test_config_initialization(self):
        """Test that config initializes with environment variables"""
        config = Config()
        
        self.assertEqual(config.region, 'us-east-1')
        self.assertEqual(config.sqs_queue_url, 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue')
        self.assertEqual(config.s3_bucket, 'test-bucket')
        self.assertEqual(config.dynamodb_table, 'test-table')
    
    def test_config_validation(self):
        """Test configuration validation"""
        with tempfile.TemporaryDirectory() as temp_dir:
            # Set temp directory for test
            os.environ['DOWNLOAD_DIR'] = temp_dir
            os.environ['TEMP_DIR'] = temp_dir
            
            config = Config()
            self.assertTrue(config.is_valid())
    
    def test_missing_required_config(self):
        """Test that missing required config raises error"""
        # Remove required environment variable
        if 'SQS_QUEUE_URL' in os.environ:
            del os.environ['SQS_QUEUE_URL']
        
        with self.assertRaises(ValueError):
            Config()

class TestQueueProcessor(unittest.TestCase):
    """Test SQS queue processing"""
    
    def setUp(self):
        self.config = Mock()
        self.config.sqs_queue_url = 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue'
        self.config.message_wait_time = 20
        self.config.get_aws_config.return_value = {'region_name': 'us-east-1'}
    
    @patch('queue_processor.boto3')
    def test_queue_processor_initialization(self, mock_boto3):
        """Test that queue processor initializes correctly"""
        mock_sqs = Mock()
        mock_boto3.client.return_value = mock_sqs
        
        processor = QueueProcessor(self.config)
        
        mock_boto3.client.assert_called_once_with('sqs', region_name='us-east-1')
        self.assertEqual(processor.sqs, mock_sqs)
    
    def test_processing_message_parsing(self):
        """Test parsing SQS messages into ProcessingMessage objects"""
        sqs_message = {
            'MessageId': 'test-message-id',
            'ReceiptHandle': 'test-receipt-handle',
            'Body': json.dumps({
                'uploadId': 'test-upload-id',
                'userId': 'test-user-id',
                's3Key': 'users/test-user/test-upload/song.mp3',
                'fileName': 'song.mp3',
                'fileSize': 5000000,
                'contentType': 'audio/mpeg',
                'metadata': {
                    'title': 'Test Song',
                    'artist': 'Test Artist'
                }
            })
        }
        
        message = ProcessingMessage.from_sqs_message(sqs_message)
        
        self.assertIsNotNone(message)
        self.assertEqual(message.upload_id, 'test-upload-id')
        self.assertEqual(message.user_id, 'test-user-id')
        self.assertEqual(message.s3_key, 'users/test-user/test-upload/song.mp3')
        self.assertEqual(message.file_name, 'song.mp3')
        self.assertEqual(message.metadata['title'], 'Test Song')
    
    def test_invalid_message_parsing(self):
        """Test that invalid messages return None"""
        invalid_message = {
            'MessageId': 'test-message-id',
            'ReceiptHandle': 'test-receipt-handle',
            'Body': 'invalid json'
        }
        
        message = ProcessingMessage.from_sqs_message(invalid_message)
        self.assertIsNone(message)

class TestS3Handler(unittest.TestCase):
    """Test S3 file operations"""
    
    def setUp(self):
        self.config = Mock()
        self.config.s3_bucket = 'test-bucket'
        self.config.download_directory = tempfile.mkdtemp()
        self.config.get_aws_config.return_value = {'region_name': 'us-east-1'}
    
    @patch('s3_handler.boto3')
    def test_s3_handler_initialization(self, mock_boto3):
        """Test S3 handler initialization"""
        mock_s3 = Mock()
        mock_boto3.client.return_value = mock_s3
        
        handler = S3Handler(self.config)
        
        mock_boto3.client.assert_called_once_with('s3', region_name='us-east-1')
        self.assertEqual(handler.s3_client, mock_s3)
    
    def test_download_path_generation(self):
        """Test local download path generation"""
        with patch('s3_handler.boto3'):
            handler = S3Handler(self.config)
            
            # Test standard S3 key format
            s3_key = 'users/user123/upload456/song.mp3'
            download_path = handler.generate_download_path(s3_key)
            
            expected_path = os.path.join(
                self.config.download_directory,
                'user123',
                'upload456',
                'song.mp3'
            )
            self.assertEqual(download_path, expected_path)

class TestStatusUpdater(unittest.TestCase):
    """Test DynamoDB status updates"""
    
    def setUp(self):
        self.config = Mock()
        self.config.dynamodb_table = 'test-table'
        self.config.get_aws_config.return_value = {'region_name': 'us-east-1'}
    
    @patch('status_updater.boto3')
    def test_status_updater_initialization(self, mock_boto3):
        """Test status updater initialization"""
        mock_dynamodb = Mock()
        mock_table = Mock()
        mock_boto3.resource.return_value = mock_dynamodb
        mock_dynamodb.Table.return_value = mock_table
        
        updater = StatusUpdater(self.config)
        
        mock_boto3.resource.assert_called_once_with('dynamodb', region_name='us-east-1')
        mock_dynamodb.Table.assert_called_once_with('test-table')
        self.assertEqual(updater.table, mock_table)
    
    def test_processing_status_enum(self):
        """Test ProcessingStatus enum values"""
        self.assertEqual(ProcessingStatus.PENDING.value, 'pending')
        self.assertEqual(ProcessingStatus.PROCESSING.value, 'processing')
        self.assertEqual(ProcessingStatus.COMPLETED.value, 'completed')
        self.assertEqual(ProcessingStatus.FAILED.value, 'failed')

if __name__ == '__main__':
    # Run the tests
    unittest.main(verbosity=2)