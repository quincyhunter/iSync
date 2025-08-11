# iSync Music Processor - EC2 Startup Script
# This script runs on EC2 instance launch to initialize and start the music processor

param(
    [string]$S3BucketName = $env:S3_BUCKET_NAME,
    [string]$SQSQueueUrl = $env:SQS_QUEUE_URL,
    [string]$DynamoDBTable = $env:DYNAMODB_TABLE,
    [string]$AWSRegion = $env:AWS_DEFAULT_REGION
)

# Set strict mode and error action
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Define paths
$iSyncRoot = "C:\iSync"
$ProcessorPath = "$iSyncRoot\processor"
$LogsPath = "$iSyncRoot\logs"
$PythonExe = "C:\Python311\python.exe"

# Function to write log messages
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $LogMessage = "[$Timestamp] [$Level] $Message"
    Write-Host $LogMessage
    
    # Also write to log file
    try {
        $LogMessage | Out-File -FilePath "$LogsPath\startup.log" -Append -Encoding UTF8
    } catch {
        # Ignore log file errors during startup
    }
}

try {
    Write-Log "=" * 60
    Write-Log "iSync Music Processor - EC2 Startup Script"
    Write-Log "=" * 60
    
    # Step 1: Create directory structure
    Write-Log "Creating directory structure..."
    @($iSyncRoot, $LogsPath, $ProcessorPath, "$iSyncRoot\downloads", "$iSyncRoot\temp") | ForEach-Object {
        if (!(Test-Path $_)) {
            New-Item -Path $_ -ItemType Directory -Force | Out-Null
            Write-Log "Created directory: $_"
        }
    }
    
    # Step 2: Set environment variables
    Write-Log "Setting environment variables..."
    
    # AWS Configuration
    if ($AWSRegion) {
        [Environment]::SetEnvironmentVariable("AWS_DEFAULT_REGION", $AWSRegion, "Machine")
        $env:AWS_DEFAULT_REGION = $AWSRegion
        Write-Log "Set AWS_DEFAULT_REGION = $AWSRegion"
    }
    
    # iSync Configuration
    if ($S3BucketName) {
        [Environment]::SetEnvironmentVariable("S3_BUCKET", $S3BucketName, "Machine")
        $env:S3_BUCKET = $S3BucketName
        Write-Log "Set S3_BUCKET = $S3BucketName"
    }
    
    if ($SQSQueueUrl) {
        [Environment]::SetEnvironmentVariable("SQS_QUEUE_URL", $SQSQueueUrl, "Machine")
        $env:SQS_QUEUE_URL = $SQSQueueUrl
        Write-Log "Set SQS_QUEUE_URL = $SQSQueueUrl"
    }
    
    if ($DynamoDBTable) {
        [Environment]::SetEnvironmentVariable("DYNAMODB_TABLE", $DynamoDBTable, "Machine")
        $env:DYNAMODB_TABLE = $DynamoDBTable
        Write-Log "Set DYNAMODB_TABLE = $DynamoDBTable"
    }
    
    # Processing Configuration
    [Environment]::SetEnvironmentVariable("DOWNLOAD_DIR", "$iSyncRoot\downloads", "Machine")
    [Environment]::SetEnvironmentVariable("TEMP_DIR", "$iSyncRoot\temp", "Machine")
    [Environment]::SetEnvironmentVariable("MAX_MESSAGES_PER_BATCH", "5", "Machine")
    [Environment]::SetEnvironmentVariable("MESSAGE_WAIT_TIME", "20", "Machine")
    [Environment]::SetEnvironmentVariable("PROCESSING_TIMEOUT", "600", "Machine")
    [Environment]::SetEnvironmentVariable("ITUNES_TIMEOUT", "120", "Machine")
    [Environment]::SetEnvironmentVariable("SYNC_TIMEOUT", "300", "Machine")
    
    $env:DOWNLOAD_DIR = "$iSyncRoot\downloads"
    $env:TEMP_DIR = "$iSyncRoot\temp"
    $env:MAX_MESSAGES_PER_BATCH = "5"
    $env:MESSAGE_WAIT_TIME = "20"
    $env:PROCESSING_TIMEOUT = "600"
    $env:ITUNES_TIMEOUT = "120"
    $env:SYNC_TIMEOUT = "300"
    
    Write-Log "Environment variables configured"
    
    # Step 3: Download processor code from S3
    if ($S3BucketName -and (Get-Command "aws" -ErrorAction SilentlyContinue)) {
        Write-Log "Downloading processor code from S3..."
        
        try {
            # Download processor code
            aws s3 sync "s3://$S3BucketName/processor/" "$ProcessorPath/" --region $AWSRegion
            Write-Log "Processor code downloaded successfully"
        } catch {
            Write-Log "Failed to download processor code from S3: $($_.Exception.Message)" "WARN"
            Write-Log "Processor may need to be deployed manually"
        }
    } else {
        Write-Log "Skipping S3 download (no bucket specified or AWS CLI not available)" "WARN"
    }
    
    # Step 4: Verify processor files exist
    $RequiredFiles = @(
        "$ProcessorPath\src\main.py",
        "$ProcessorPath\src\config.py",
        "$ProcessorPath\src\queue_processor.py",
        "$ProcessorPath\src\s3_handler.py",
        "$ProcessorPath\src\itunes_controller.py",
        "$ProcessorPath\src\status_updater.py"
    )
    
    $MissingFiles = @()
    foreach ($File in $RequiredFiles) {
        if (!(Test-Path $File)) {
            $MissingFiles += $File
        }
    }
    
    if ($MissingFiles.Count -gt 0) {
        Write-Log "Missing processor files:" "WARN"
        $MissingFiles | ForEach-Object { Write-Log "  $_" "WARN" }
        Write-Log "Processor may not start correctly" "WARN"
    }
    
    # Step 5: Install/update Python dependencies
    if (Test-Path $PythonExe) {
        Write-Log "Installing Python dependencies..."
        
        try {
            # Install core dependencies
            & $PythonExe -m pip install --upgrade pip
            & $PythonExe -m pip install boto3 pywin32 python-dateutil requests
            
            Write-Log "Python dependencies installed successfully"
        } catch {
            Write-Log "Failed to install Python dependencies: $($_.Exception.Message)" "ERROR"
        }
    } else {
        Write-Log "Python executable not found at $PythonExe" "ERROR"
    }
    
    # Step 6: Initialize iTunes (if running interactively)
    Write-Log "Checking iTunes installation..."
    $iTunesPath = "${env:ProgramFiles}\iTunes\iTunes.exe"
    if (Test-Path $iTunesPath) {
        Write-Log "iTunes found at: $iTunesPath"
        
        # In an interactive session, we could start iTunes
        # In a service context, this may not work
        try {
            Write-Log "Attempting to initialize iTunes..."
            # Start iTunes in the background (may not work in service context)
            Start-Process -FilePath $iTunesPath -WindowStyle Hidden -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 5
            Write-Log "iTunes initialization attempted"
        } catch {
            Write-Log "iTunes initialization failed (this is expected in service context)" "WARN"
        }
    } else {
        Write-Log "iTunes not found - processor will fail until iTunes is installed" "ERROR"
    }
    
    # Step 7: Create and register scheduled task for processor
    Write-Log "Creating scheduled task for processor..."
    
    try {
        $TaskName = "iSyncMusicProcessor"
        $TaskDescription = "iSync Music Processor - Processes music files from SQS queue"
        
        # Remove existing task if it exists
        try {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        } catch {
            # Ignore errors if task doesn't exist
        }
        
        # Create new task action
        $Action = New-ScheduledTaskAction -Execute $PythonExe -Argument "$ProcessorPath\src\main.py" -WorkingDirectory "$ProcessorPath\src"
        
        # Create trigger (start at boot and restart on failure)
        $Trigger = New-ScheduledTaskTrigger -AtStartup
        
        # Create settings
        $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
        
        # Create principal (run as SYSTEM)
        $Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
        
        # Register the task
        Register-ScheduledTask -TaskName $TaskName -Description $TaskDescription -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal
        
        Write-Log "Scheduled task '$TaskName' created successfully"
        
        # Start the task immediately
        Start-ScheduledTask -TaskName $TaskName
        Write-Log "Scheduled task started"
        
    } catch {
        Write-Log "Failed to create scheduled task: $($_.Exception.Message)" "ERROR"
        Write-Log "Processor will need to be started manually"
    }
    
    # Step 8: Configure Windows Event Log source (for better logging)
    try {
        if (![System.Diagnostics.EventLog]::SourceExists("iSyncProcessor")) {
            New-EventLog -LogName Application -Source "iSyncProcessor"
            Write-Log "Created Windows Event Log source 'iSyncProcessor'"
        }
    } catch {
        Write-Log "Could not create Event Log source (may require elevated privileges)" "WARN"
    }
    
    # Step 9: Signal CloudFormation (if running in CloudFormation context)
    if ($env:AWS_CFN_SIGNAL_URL) {
        Write-Log "Signaling CloudFormation stack..."
        try {
            $SignalData = @{
                Status = "SUCCESS"
                UniqueId = $env:COMPUTERNAME
                Data = "iSync processor startup completed successfully"
            } | ConvertTo-Json
            
            Invoke-RestMethod -Uri $env:AWS_CFN_SIGNAL_URL -Method PUT -Body $SignalData -ContentType "application/json"
            Write-Log "CloudFormation signaled successfully"
        } catch {
            Write-Log "Failed to signal CloudFormation: $($_.Exception.Message)" "WARN"
        }
    }
    
    # Step 10: Wait and verify processor is running
    Write-Log "Waiting for processor to initialize..."
    Start-Sleep -Seconds 10
    
    try {
        $ProcessorTask = Get-ScheduledTask -TaskName "iSyncMusicProcessor" -ErrorAction SilentlyContinue
        if ($ProcessorTask -and $ProcessorTask.State -eq "Running") {
            Write-Log "Processor is running successfully"
        } else {
            Write-Log "Processor task state: $($ProcessorTask.State)" "WARN"
        }
    } catch {
        Write-Log "Could not verify processor status" "WARN"
    }
    
    Write-Log "Startup completed successfully!"
    Write-Log "Processor logs will be written to: $LogsPath\processor.log"
    Write-Log "To monitor processor: Get-ScheduledTask -TaskName 'iSyncMusicProcessor'"
    Write-Log "To view logs: Get-Content '$LogsPath\processor.log' -Tail 50 -Wait"
    
} catch {
    Write-Log "Startup failed: $($_.Exception.Message)" "ERROR"
    Write-Log "Stack trace: $($_.ScriptStackTrace)" "ERROR"
    
    # Signal failure to CloudFormation if applicable
    if ($env:AWS_CFN_SIGNAL_URL) {
        try {
            $SignalData = @{
                Status = "FAILED"
                UniqueId = $env:COMPUTERNAME
                Data = "iSync processor startup failed: $($_.Exception.Message)"
            } | ConvertTo-Json
            
            Invoke-RestMethod -Uri $env:AWS_CFN_SIGNAL_URL -Method PUT -Body $SignalData -ContentType "application/json"
        } catch {
            # Ignore signaling errors
        }
    }
    
    exit 1
}

Write-Log "=" * 60
Write-Log "EC2 startup script completed"
Write-Log "=" * 60