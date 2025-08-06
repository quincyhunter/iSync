<powershell>
# iSync Music Processing Instance Initialization Script (Windows)
# This script sets up the Windows Server instance for music processing with iTunes

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Variables from Terraform
$environment = "${environment}"
$queueUrl = "${queue_url}"
$uploadBucket = "${upload_bucket}"
$uploadTable = "${upload_table}"
$awsRegion = "${aws_region}"

# Logging function
function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logMessage = "[$timestamp] $Message"
    Write-Output $logMessage
    Add-Content -Path "C:\iSync\setup.log" -Value $logMessage
}

Write-Log "Starting iSync processor instance initialization..."
Write-Log "Environment: $environment"
Write-Log "Queue URL: $queueUrl"
Write-Log "Upload Bucket: $uploadBucket"

# Create application directory
New-Item -Path "C:\iSync" -ItemType Directory -Force
Set-Location "C:\iSync"

# Install Chocolatey package manager
Write-Log "Installing Chocolatey package manager..."
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# Refresh environment variables
$env:ChocolateyInstall = Convert-Path "$((Get-Command choco).Path)\..\.."
Import-Module "$env:ChocolateyInstall\helpers\chocolateyProfile.psm1"
refreshenv

# Install required packages
Write-Log "Installing required packages..."
choco install -y python3 awscli git curl

# Install iTunes (required for music processing)
Write-Log "Installing iTunes..."
choco install -y itunes

# Install Python dependencies
Write-Log "Installing Python dependencies..."
python -m pip install --upgrade pip
python -m pip install boto3 botocore python-dotenv requests pywin32 comtypes

# Create environment configuration
Write-Log "Creating environment configuration..."
$envContent = @"
ENVIRONMENT=$environment
AWS_DEFAULT_REGION=$awsRegion
QUEUE_URL=$queueUrl
UPLOAD_BUCKET=$uploadBucket
UPLOAD_TABLE=$uploadTable
PYTHONPATH=C:\iSync
"@
Set-Content -Path "C:\iSync\.env" -Value $envContent

# Create the main processor script
Write-Log "Creating main processor script..."
$processorScript = @'
"""
iSync Music Processor for Windows
Processes music files from SQS queue and adds them to iTunes library
"""

import os
import sys
import json
import time
import logging
import subprocess
import tempfile
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any, Optional
import win32com.client
import comtypes

import boto3
from botocore.exceptions import ClientError

# Configure logging
log_file = Path("C:/iSync/processor.log")
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(log_file),
        logging.StreamHandler()
    ]
)

logger = logging.getLogger(__name__)

class WindowsMusicProcessor:
    """Processes music files using Windows iTunes COM interface"""
    
    def __init__(self):
        self.s3_client = boto3.client('s3')
        self.sqs_client = boto3.client('sqs')
        self.dynamodb = boto3.resource('dynamodb')
        
        self.queue_url = os.environ['QUEUE_URL']
        self.upload_bucket = os.environ['UPLOAD_BUCKET']
        self.upload_table = self.dynamodb.Table(os.environ['UPLOAD_TABLE'])
        
        self.working_dir = Path(tempfile.gettempdir()) / "isync-processing"
        self.working_dir.mkdir(exist_ok=True)
        
        # Initialize iTunes COM interface
        self.itunes = None
        self._init_itunes()
        
        logger.info(f"Initialized processor with bucket: {self.upload_bucket}")
        logger.info(f"Queue URL: {self.queue_url}")

    def _init_itunes(self):
        """Initialize iTunes COM interface"""
        try:
            logger.info("Initializing iTunes COM interface...")
            self.itunes = win32com.client.Dispatch("iTunes.Application")
            
            # Start iTunes if not running
            if not self.itunes:
                logger.info("Starting iTunes application...")
                subprocess.run(["iTunes.exe"], check=False)
                time.sleep(10)  # Give iTunes time to start
                self.itunes = win32com.client.Dispatch("iTunes.Application")
            
            # Get the main library
            self.main_library = self.itunes.LibraryPlaylist
            logger.info("iTunes COM interface initialized successfully")
            
        except Exception as e:
            logger.error(f"Failed to initialize iTunes: {e}")
            raise

    def process_queue(self):
        """Process all messages in the SQS queue"""
        logger.info("Starting queue processing...")
        
        processed_count = 0
        while True:
            try:
                # Receive messages from SQS
                response = self.sqs_client.receive_message(
                    QueueUrl=self.queue_url,
                    MaxNumberOfMessages=10,
                    WaitTimeSeconds=20,
                    VisibilityTimeoutSeconds=300
                )
                
                messages = response.get('Messages', [])
                if not messages:
                    logger.info("No more messages in queue")
                    break
                
                for message in messages:
                    try:
                        self.process_message(message)
                        processed_count += 1
                        
                        # Delete message after successful processing
                        self.sqs_client.delete_message(
                            QueueUrl=self.queue_url,
                            ReceiptHandle=message['ReceiptHandle']
                        )
                        
                    except Exception as e:
                        logger.error(f"Error processing message: {e}")
                        
            except Exception as e:
                logger.error(f"Error receiving messages: {e}")
                break
        
        logger.info(f"Processed {processed_count} files")
        return processed_count

    def process_message(self, message: Dict[str, Any]):
        """Process a single SQS message"""
        body = json.loads(message['Body'])
        upload_id = body.get('uploadId')
        user_id = body.get('userId')
        s3_key = body.get('s3Key')
        
        logger.info(f"Processing upload {upload_id} for user {user_id}")
        
        # Update status to processing
        self.update_status(upload_id, user_id, 'processing')
        
        try:
            # Download file from S3
            local_file = self.download_file(s3_key)
            
            # Add to iTunes library
            success = self.add_to_itunes(local_file, body.get('metadata', {}))
            
            if success:
                self.update_status(upload_id, user_id, 'completed')
                logger.info(f"Successfully processed {upload_id}")
            else:
                self.update_status(upload_id, user_id, 'failed', 'iTunes processing failed')
                logger.error(f"Failed to process {upload_id}")
                
        except Exception as e:
            logger.error(f"Error processing {upload_id}: {e}")
            self.update_status(upload_id, user_id, 'failed', str(e))
        finally:
            # Cleanup
            if 'local_file' in locals():
                try:
                    local_file.unlink(missing_ok=True)
                except:
                    pass

    def download_file(self, s3_key: str) -> Path:
        """Download file from S3"""
        filename = Path(s3_key).name
        local_file = self.working_dir / filename
        
        logger.info(f"Downloading {s3_key} to {local_file}")
        
        self.s3_client.download_file(
            self.upload_bucket,
            s3_key,
            str(local_file)
        )
        
        return local_file

    def add_to_itunes(self, file_path: Path, metadata: Dict[str, Any]) -> bool:
        """Add file to iTunes library using COM interface"""
        logger.info(f"Adding {file_path} to iTunes library")
        
        try:
            # Add file to iTunes
            operation_status = self.itunes.LibraryPlaylist.AddFile(str(file_path))
            
            if operation_status:
                logger.info(f"Successfully added {file_path.name} to iTunes")
                
                # Move file to processed folder in S3
                processed_key = f"processed/{file_path.name}"
                try:
                    copy_source = {'Bucket': self.upload_bucket, 'Key': str(file_path.name)}
                    self.s3_client.copy_object(
                        CopySource=copy_source,
                        Bucket=self.upload_bucket,
                        Key=processed_key
                    )
                    logger.info(f"Moved file to processed folder: {processed_key}")
                except Exception as e:
                    logger.warning(f"Failed to move file to processed folder: {e}")
                
                return True
            else:
                logger.error(f"iTunes failed to add file: {file_path}")
                return False
                
        except Exception as e:
            logger.error(f"Error adding file to iTunes: {e}")
            return False

    def update_status(self, upload_id: str, user_id: str, status: str, error: str = None):
        """Update upload status in DynamoDB"""
        try:
            update_expression = "SET #status = :status, updatedAt = :updated"
            expression_values = {
                ':status': status,
                ':updated': int(datetime.utcnow().timestamp())
            }
            expression_names = {'#status': 'status'}
            
            if error:
                update_expression += ", #error = :error"
                expression_values[':error'] = error
                expression_names['#error'] = 'error'
            
            if status == 'completed':
                update_expression += ", completedAt = :completed"
                expression_values[':completed'] = int(datetime.utcnow().timestamp())
            
            self.upload_table.update_item(
                Key={'uploadId': upload_id, 'userId': user_id},
                UpdateExpression=update_expression,
                ExpressionAttributeValues=expression_values,
                ExpressionAttributeNames=expression_names
            )
            
            logger.info(f"Updated status for {upload_id}: {status}")
            
        except Exception as e:
            logger.error(f"Failed to update status for {upload_id}: {e}")

def main():
    """Main entry point"""
    logger.info("Starting iSync Music Processor (Windows)")
    
    try:
        processor = WindowsMusicProcessor()
        processed_count = processor.process_queue()
        
        logger.info(f"Processing complete. Processed {processed_count} files.")
        
        # If no files were processed, shut down the instance after a short delay
        if processed_count == 0:
            logger.info("No files to process, shutting down instance in 5 minutes")
            time.sleep(300)
            
            # Shutdown the instance
            try:
                import urllib.request
                instance_id_url = "http://169.254.169.254/latest/meta-data/instance-id"
                instance_id = urllib.request.urlopen(instance_id_url, timeout=5).read().decode()
                
                if instance_id:
                    ec2_client = boto3.client('ec2')
                    ec2_client.terminate_instances(InstanceIds=[instance_id])
                    logger.info(f"Terminated instance {instance_id}")
            except Exception as e:
                logger.error(f"Failed to terminate instance: {e}")
    
    except Exception as e:
        logger.error(f"Fatal error in main: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
'@

Set-Content -Path "C:\iSync\processor.py" -Value $processorScript

# Create Windows service configuration
Write-Log "Creating Windows service..."
$serviceScript = @'
import sys
import time
import win32serviceutil
import win32service
import win32event
from pathlib import Path

# Add the script directory to Python path
sys.path.insert(0, str(Path(__file__).parent))

from processor import main

class iSyncProcessorService(win32serviceutil.ServiceFramework):
    _svc_name_ = "iSyncProcessor"
    _svc_display_name_ = "iSync Music Processor Service"
    _svc_description_ = "Processes music uploads for iSync Music Manager"

    def __init__(self, args):
        win32serviceutil.ServiceFramework.__init__(self, args)
        self.hWaitStop = win32event.CreateEvent(None, 0, 0, None)

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        win32event.SetEvent(self.hWaitStop)

    def SvcDoRun(self):
        try:
            main()
        except Exception as e:
            with open("C:\\iSync\\service_error.log", "a") as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} - Service error: {str(e)}\n")

if __name__ == '__main__':
    win32serviceutil.HandleCommandLine(iSyncProcessorService)
'@

Set-Content -Path "C:\iSync\service.py" -Value $serviceScript

# Install the service
Write-Log "Installing Windows service..."
try {
    python "C:\iSync\service.py" install
    Write-Log "Service installed successfully"
} catch {
    Write-Log "Service installation failed: $($_.Exception.Message)"
}

# Create startup script that will run the processor immediately
Write-Log "Creating startup script..."
$startupScript = @'
@echo off
cd /d C:\iSync
python processor.py
'@

Set-Content -Path "C:\iSync\run_processor.bat" -Value $startupScript

# Run the processor immediately on startup
Write-Log "Starting initial processing..."
Start-Process -FilePath "C:\iSync\run_processor.bat" -WindowStyle Hidden -Wait

Write-Log "iSync processor instance initialization complete"

# Signal successful completion
$successFile = "C:\iSync\initialization_complete.txt"
Set-Content -Path $successFile -Value "iSync initialization completed at $(Get-Date)"

Write-Log "Instance is ready for music processing"
</powershell>
'