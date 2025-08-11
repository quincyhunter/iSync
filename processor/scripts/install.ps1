# iSync Music Processor - Installation Script
# This script installs all required dependencies for the music processor on Windows Server 2022

param(
    [switch]$Force = $false
)

# Set strict mode and error action
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Define installation paths
$PythonPath = "C:\Python311"
$iSyncRoot = "C:\iSync"
$LogsPath = "$iSyncRoot\logs"
$ProcessorPath = "$iSyncRoot\processor"

Write-Host "=" * 60
Write-Host "iSync Music Processor - Installation Script"
Write-Host "=" * 60

# Function to write log messages
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$Timestamp] [$Level] $Message"
}

# Function to test if a command exists
function Test-Command {
    param([string]$Command)
    try {
        Get-Command $Command -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

# Function to download file with retry logic
function Download-File {
    param(
        [string]$Url,
        [string]$OutputPath,
        [int]$MaxRetries = 3
    )
    
    for ($i = 1; $i -le $MaxRetries; $i++) {
        try {
            Write-Log "Downloading $Url (attempt $i/$MaxRetries)"
            Invoke-WebRequest -Uri $Url -OutFile $OutputPath -TimeoutSec 300
            Write-Log "Download completed successfully"
            return $true
        } catch {
            Write-Log "Download attempt $i failed: $($_.Exception.Message)" "WARN"
            if ($i -eq $MaxRetries) {
                Write-Log "All download attempts failed" "ERROR"
                return $false
            }
            Start-Sleep -Seconds (5 * $i)  # Exponential backoff
        }
    }
}

try {
    # Step 1: Set execution policy
    Write-Log "Setting PowerShell execution policy..."
    Set-ExecutionPolicy -ExecutionPolicy Unrestricted -Force -Scope LocalMachine
    
    # Step 2: Create directory structure
    Write-Log "Creating directory structure..."
    @($iSyncRoot, $LogsPath, $ProcessorPath, "$iSyncRoot\downloads", "$iSyncRoot\temp") | ForEach-Object {
        if (!(Test-Path $_)) {
            New-Item -Path $_ -ItemType Directory -Force | Out-Null
            Write-Log "Created directory: $_"
        }
    }
    
    # Step 3: Install Python 3.11 if not present
    if (!(Test-Path "$PythonPath\python.exe") -or $Force) {
        Write-Log "Installing Python 3.11..."
        $PythonInstaller = "$env:TEMP\python-3.11.7-amd64.exe"
        
        if (Download-File -Url "https://www.python.org/ftp/python/3.11.7/python-3.11.7-amd64.exe" -OutputPath $PythonInstaller) {
            Write-Log "Running Python installer..."
            Start-Process -FilePath $PythonInstaller -ArgumentList @(
                "/quiet",
                "InstallAllUsers=1",
                "PrependPath=1",
                "Include_test=0",
                "SimpleInstall=1",
                "TargetDir=$PythonPath"
            ) -Wait
            
            # Verify installation
            if (Test-Path "$PythonPath\python.exe") {
                Write-Log "Python installed successfully"
                Remove-Item $PythonInstaller -Force -ErrorAction SilentlyContinue
            } else {
                throw "Python installation failed - executable not found"
            }
        } else {
            throw "Failed to download Python installer"
        }
    } else {
        Write-Log "Python 3.11 already installed"
    }
    
    # Step 4: Install iTunes if not present
    $iTunesPath = "${env:ProgramFiles}\iTunes\iTunes.exe"
    if (!(Test-Path $iTunesPath) -or $Force) {
        Write-Log "Installing iTunes..."
        $iTunesInstaller = "$env:TEMP\iTunes64Setup.exe"
        
        # Note: Direct download URL may change - in production, store installer in S3
        $iTunesDownloadUrl = "https://secure-appldnld.apple.com/itunes12/001-97787-20210421-F0E5A3C2-A2F9-11EB-A40B-A128318AD179/iTunes64Setup.exe"
        
        if (Download-File -Url $iTunesDownloadUrl -OutputPath $iTunesInstaller) {
            Write-Log "Running iTunes installer..."
            Start-Process -FilePath $iTunesInstaller -ArgumentList "/quiet" -Wait
            
            # Verify installation
            if (Test-Path $iTunesPath) {
                Write-Log "iTunes installed successfully"
                Remove-Item $iTunesInstaller -Force -ErrorAction SilentlyContinue
            } else {
                Write-Log "iTunes installation may have failed, but continuing..." "WARN"
            }
        } else {
            Write-Log "Failed to download iTunes installer, but continuing..." "WARN"
        }
    } else {
        Write-Log "iTunes already installed"
    }
    
    # Step 5: Update PATH environment variable
    Write-Log "Updating system PATH..."
    $CurrentPath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
    $PathsToAdd = @($PythonPath, "$PythonPath\Scripts")
    
    foreach ($PathToAdd in $PathsToAdd) {
        if ($CurrentPath -notlike "*$PathToAdd*") {
            $CurrentPath = "$CurrentPath;$PathToAdd"
            Write-Log "Added to PATH: $PathToAdd"
        }
    }
    
    [Environment]::SetEnvironmentVariable("PATH", $CurrentPath, "Machine")
    $env:PATH = $CurrentPath  # Update current session
    
    # Step 6: Install Python dependencies
    Write-Log "Installing Python dependencies..."
    $PipExe = "$PythonPath\python.exe"
    
    # Upgrade pip first
    & $PipExe -m pip install --upgrade pip
    
    # Install required packages
    $PythonPackages = @(
        "boto3>=1.26.0",
        "pywin32>=306",
        "python-dateutil>=2.8.0",
        "requests>=2.28.0"
    )
    
    foreach ($Package in $PythonPackages) {
        Write-Log "Installing Python package: $Package"
        & $PipExe -m pip install $Package
    }
    
    # Step 7: Install AWS CLI if not present
    if (!(Test-Command "aws") -or $Force) {
        Write-Log "Installing AWS CLI..."
        $AwsCliInstaller = "$env:TEMP\AWSCLIV2.msi"
        
        if (Download-File -Url "https://awscli.amazonaws.com/AWSCLIV2.msi" -OutputPath $AwsCliInstaller) {
            Write-Log "Running AWS CLI installer..."
            Start-Process -FilePath "msiexec.exe" -ArgumentList "/i", $AwsCliInstaller, "/quiet" -Wait
            
            # Update PATH for current session
            $env:PATH = "$env:PATH;$env:ProgramFiles\Amazon\AWSCLIV2"
            
            Write-Log "AWS CLI installed successfully"
            Remove-Item $AwsCliInstaller -Force -ErrorAction SilentlyContinue
        } else {
            Write-Log "Failed to download AWS CLI installer" "ERROR"
        }
    } else {
        Write-Log "AWS CLI already installed"
    }
    
    # Step 8: Configure Windows services and firewall
    Write-Log "Configuring Windows settings..."
    
    # Disable Windows Defender real-time protection for processing directories (optional)
    try {
        Add-MpPreference -ExclusionPath $iSyncRoot -ErrorAction SilentlyContinue
        Write-Log "Added Windows Defender exclusion for $iSyncRoot"
    } catch {
        Write-Log "Could not configure Windows Defender exclusion (may require manual configuration)" "WARN"
    }
    
    # Step 9: Create service account (if needed)
    # Note: In production, this would be handled by IAM roles
    
    # Step 10: Verify installations
    Write-Log "Verifying installations..."
    
    # Check Python
    try {
        $PythonVersion = & $PipExe --version
        Write-Log "Python version: $PythonVersion"
    } catch {
        Write-Log "Python verification failed" "ERROR"
    }
    
    # Check iTunes (may not work in service context)
    if (Test-Path $iTunesPath) {
        Write-Log "iTunes executable found at: $iTunesPath"
    } else {
        Write-Log "iTunes executable not found" "WARN"
    }
    
    # Check AWS CLI
    if (Test-Command "aws") {
        try {
            $AwsVersion = aws --version
            Write-Log "AWS CLI version: $AwsVersion"
        } catch {
            Write-Log "AWS CLI installed but not responding properly" "WARN"
        }
    } else {
        Write-Log "AWS CLI not found in PATH" "ERROR"
    }
    
    Write-Log "Installation completed successfully!"
    Write-Log "Next steps:"
    Write-Log "1. Configure AWS credentials (aws configure or IAM role)"
    Write-Log "2. Deploy processor code to $ProcessorPath"
    Write-Log "3. Configure environment variables"
    Write-Log "4. Run startup.ps1 to start the processor"
    
} catch {
    Write-Log "Installation failed: $($_.Exception.Message)" "ERROR"
    Write-Log "Stack trace: $($_.ScriptStackTrace)" "ERROR"
    exit 1
}

Write-Host "=" * 60
Write-Host "Installation completed successfully!"
Write-Host "=" * 60