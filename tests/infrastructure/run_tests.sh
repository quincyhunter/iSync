#!/bin/bash

# iSync Infrastructure Test Runner
# Runs comprehensive infrastructure validation tests

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVIRONMENT="${1:-prod}"

# Color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

print_status() { echo -e "${GREEN}✓${NC} $1"; }
print_warning() { echo -e "${YELLOW}⚠${NC} $1"; }
print_error() { echo -e "${RED}✗${NC} $1"; }

echo -e "${GREEN}🧪 iSync Infrastructure Test Suite${NC}"
echo "Environment: $ENVIRONMENT"
echo ""

# Check prerequisites
print_status "Checking prerequisites..."

# Check Python
if ! command -v python3 &> /dev/null; then
    print_error "Python 3 is required but not installed"
    exit 1
fi

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    print_error "AWS CLI is required but not installed"
    exit 1
fi

# Check AWS credentials
if ! aws sts get-caller-identity &> /dev/null; then
    print_error "AWS credentials not configured"
    exit 1
fi

print_status "Prerequisites check passed"

# Install Python dependencies
print_status "Installing test dependencies..."
cd "$SCRIPT_DIR"

if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

source venv/bin/activate
pip install -q --upgrade pip
pip install -q -r requirements.txt

print_status "Dependencies installed"

# Set environment variables
export ENVIRONMENT="$ENVIRONMENT"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

# Run tests
print_status "Running infrastructure tests..."

# Run with coverage and detailed output
pytest \
    test_terraform.py \
    -v \
    --tb=short \
    --cov=. \
    --cov-report=html \
    --cov-report=term-missing \
    --junit-xml=test-results.xml \
    -m "not slow" \
    "$@"

TEST_EXIT_CODE=$?

# Generate test report
if [ $TEST_EXIT_CODE -eq 0 ]; then
    print_status "All tests passed! ✨"
    echo ""
    echo "Test Report:"
    echo "- Coverage report: file://$(pwd)/htmlcov/index.html"
    echo "- JUnit XML: $(pwd)/test-results.xml"
else
    print_error "Some tests failed!"
    echo ""
    echo "Check the test output above for details."
fi

echo ""
echo "Test run completed for environment: $ENVIRONMENT"

deactivate

exit $TEST_EXIT_CODE