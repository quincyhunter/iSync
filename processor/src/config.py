"""
Configuration Management for iSync Music Processor
Handles environment variables and AWS configuration for Windows EC2 instances
"""

import os
import logging
from typing import Optional
from dataclasses import dataclass

logger = logging.getLogger(__name__)

@dataclass
class Config:
    """Configuration settings for the music processor"""
    
    # AWS Configuration
    region: str
    sqs_queue_url: str
    dynamodb_table: str
    s3_bucket: str
    
    # Processing Configuration
    max_messages_per_batch: int
    message_wait_time: int
    processing_timeout: int
    
    # iTunes Configuration
    itunes_timeout: int
    sync_timeout: int
    
    # Local Storage
    download_directory: str
    temp_directory: str
    
    def __init__(self):
        """Initialize configuration from environment variables"""
        
        # AWS Configuration
        self.region = os.getenv('AWS_REGION', 'us-east-1')
        self.sqs_queue_url = self._get_required_env('SQS_QUEUE_URL')
        self.dynamodb_table = os.getenv('DYNAMODB_TABLE', 'isync-upload-queue')
        self.s3_bucket = self._get_required_env('S3_BUCKET')
        
        # Processing Configuration
        self.max_messages_per_batch = int(os.getenv('MAX_MESSAGES_PER_BATCH', '10'))
        self.message_wait_time = int(os.getenv('MESSAGE_WAIT_TIME', '20'))
        self.processing_timeout = int(os.getenv('PROCESSING_TIMEOUT', '300'))
        
        # iTunes Configuration
        self.itunes_timeout = int(os.getenv('ITUNES_TIMEOUT', '60'))
        self.sync_timeout = int(os.getenv('SYNC_TIMEOUT', '120'))
        
        # Local Storage
        self.download_directory = os.getenv('DOWNLOAD_DIR', r'C:\iSync\downloads')
        self.temp_directory = os.getenv('TEMP_DIR', r'C:\iSync\temp')
        
        # Create directories if they don't exist
        self._create_directories()
        
        # Log configuration (excluding sensitive data)
        self._log_configuration()
    
    def _get_required_env(self, key: str) -> str:
        """Get required environment variable or raise error"""
        value = os.getenv(key)
        if not value:
            raise ValueError(f"Required environment variable {key} is not set")
        return value
    
    def _create_directories(self) -> None:
        """Create required directories if they don't exist"""
        directories = [
            self.download_directory,
            self.temp_directory
        ]
        
        for directory in directories:
            try:
                os.makedirs(directory, exist_ok=True)
                logger.info(f"Created directory: {directory}")
            except Exception as e:
                logger.error(f"Failed to create directory {directory}: {e}")
                raise
    
    def _log_configuration(self) -> None:
        """Log current configuration (excluding sensitive data)"""
        logger.info("Processor configuration loaded:")
        logger.info(f"  AWS Region: {self.region}")
        logger.info(f"  DynamoDB Table: {self.dynamodb_table}")
        logger.info(f"  S3 Bucket: {self.s3_bucket}")
        logger.info(f"  Max Messages per Batch: {self.max_messages_per_batch}")
        logger.info(f"  Message Wait Time: {self.message_wait_time}s")
        logger.info(f"  Processing Timeout: {self.processing_timeout}s")
        logger.info(f"  Download Directory: {self.download_directory}")
        logger.info(f"  Temp Directory: {self.temp_directory}")

    def get_aws_config(self) -> dict:
        """Get AWS configuration dictionary"""
        return {
            'region_name': self.region
        }
    
    def is_valid(self) -> bool:
        """Validate that all required configuration is present"""
        try:
            required_attrs = [
                'sqs_queue_url',
                's3_bucket',
                'download_directory',
                'temp_directory'
            ]
            
            for attr in required_attrs:
                if not getattr(self, attr):
                    logger.error(f"Missing required configuration: {attr}")
                    return False
            
            # Check if directories are writable
            test_file = os.path.join(self.temp_directory, 'test.tmp')
            try:
                with open(test_file, 'w') as f:
                    f.write('test')
                os.remove(test_file)
            except Exception as e:
                logger.error(f"Cannot write to temp directory {self.temp_directory}: {e}")
                return False
            
            logger.info("Configuration validation successful")
            return True
            
        except Exception as e:
            logger.error(f"Configuration validation failed: {e}")
            return False

# Global configuration instance
config: Optional[Config] = None

def get_config() -> Config:
    """Get global configuration instance (singleton pattern)"""
    global config
    if config is None:
        config = Config()
    return config

def reload_config() -> Config:
    """Reload configuration from environment variables"""
    global config
    config = Config()
    return config