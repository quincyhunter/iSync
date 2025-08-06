"""
Pytest configuration for infrastructure tests
"""

import os
import pytest
from pathlib import Path

def pytest_configure(config):
    """Configure pytest with custom markers"""
    config.addinivalue_line(
        "markers", "integration: marks tests as integration tests"
    )
    config.addinivalue_line(
        "markers", "slow: marks tests as slow running"
    )
    config.addinivalue_line(
        "markers", "aws: marks tests that require AWS credentials"
    )

@pytest.fixture(scope="session")
def aws_credentials():
    """Check if AWS credentials are available"""
    try:
        import boto3
        # This will raise an exception if credentials are not available
        boto3.client('sts').get_caller_identity()
        return True
    except Exception:
        pytest.skip("AWS credentials not available")

@pytest.fixture(scope="session") 
def terraform_outputs():
    """Load Terraform outputs for testing"""
    environment = os.getenv('ENVIRONMENT', 'prod')
    outputs_file = Path(__file__).parent.parent.parent / 'infrastructure' / 'terraform' / f'outputs-{environment}.json'
    
    if not outputs_file.exists():
        pytest.skip("Terraform outputs not found. Deploy infrastructure first.")
    
    import json
    with open(outputs_file, 'r') as f:
        outputs = json.load(f)
    
    # Extract values from Terraform output format
    return {k: v.get('value') for k, v in outputs.items()}

@pytest.fixture
def environment():
    """Get the current environment"""
    return os.getenv('ENVIRONMENT', 'prod')