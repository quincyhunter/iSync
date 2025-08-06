#!/bin/bash

# iSync Local File Loader - Infrastructure Deployment Script
# This script deploys the complete infrastructure using Terraform

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="$(cd "$SCRIPT_DIR/../terraform" && pwd)"
ENVIRONMENT="${1:-prod}"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 iSync Local File Loader - Infrastructure Deployment${NC}"
echo "Environment: $ENVIRONMENT"
echo "Terraform Directory: $TERRAFORM_DIR"
echo ""

# Function to print colored messages
print_status() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    print_status "Checking prerequisites..."
    
    # Check if AWS CLI is installed
    if ! command -v aws &> /dev/null; then
        print_error "AWS CLI is not installed. Please install it first."
        exit 1
    fi
    
    # Check if Terraform is installed
    if ! command -v terraform &> /dev/null; then
        print_error "Terraform is not installed. Please install it first."
        exit 1
    fi
    
    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        print_error "AWS credentials not configured. Please run 'aws configure' first."
        exit 1
    fi
    
    # Check Terraform version
    TERRAFORM_VERSION=$(terraform version -json | jq -r '.terraform_version')
    print_status "Terraform version: $TERRAFORM_VERSION"
    
    # Check AWS CLI version
    AWS_VERSION=$(aws --version 2>&1 | cut -d/ -f2 | cut -d' ' -f1)
    print_status "AWS CLI version: $AWS_VERSION"
    
    # Get AWS account info
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    AWS_REGION=$(aws configure get region || echo "us-east-1")
    print_status "AWS Account: $ACCOUNT_ID"
    print_status "AWS Region: $AWS_REGION"
    
    echo ""
}

# Initialize Terraform
init_terraform() {
    print_status "Initializing Terraform..."
    cd "$TERRAFORM_DIR"
    
    # Initialize Terraform
    terraform init -upgrade
    
    # Select or create workspace
    terraform workspace select "$ENVIRONMENT" 2>/dev/null || terraform workspace new "$ENVIRONMENT"
    
    print_status "Terraform initialized for environment: $ENVIRONMENT"
    echo ""
}

# Plan infrastructure changes
plan_infrastructure() {
    print_status "Planning infrastructure changes..."
    cd "$TERRAFORM_DIR"
    
    # Generate plan
    terraform plan \
        -var="environment=$ENVIRONMENT" \
        -out="tfplan-$ENVIRONMENT" \
        -detailed-exitcode
    
    PLAN_EXIT_CODE=$?
    
    case $PLAN_EXIT_CODE in
        0)
            print_status "No changes detected."
            ;;
        1)
            print_error "Terraform plan failed."
            exit 1
            ;;
        2)
            print_warning "Changes detected. Plan saved to tfplan-$ENVIRONMENT"
            ;;
    esac
    
    echo ""
    return $PLAN_EXIT_CODE
}

# Apply infrastructure changes
apply_infrastructure() {
    print_status "Applying infrastructure changes..."
    cd "$TERRAFORM_DIR"
    
    if [ -f "tfplan-$ENVIRONMENT" ]; then
        terraform apply "tfplan-$ENVIRONMENT"
    else
        print_error "No plan file found. Run plan first."
        exit 1
    fi
    
    print_status "Infrastructure deployment completed!"
    echo ""
}

# Show outputs
show_outputs() {
    print_status "Infrastructure outputs:"
    cd "$TERRAFORM_DIR"
    
    terraform output -json > "outputs-$ENVIRONMENT.json"
    
    # Display key outputs
    echo ""
    echo "API Endpoint: $(terraform output -raw api_endpoint)"
    echo "S3 Bucket: $(terraform output -raw upload_bucket_name)"
    echo "DynamoDB Table: $(terraform output -raw upload_table_name)"
    echo "SQS Queue: $(terraform output -raw queue_url)"
    echo "CloudWatch Dashboard: $(terraform output -raw cloudwatch_dashboard_url)"
    
    echo ""
    print_status "Complete outputs saved to outputs-$ENVIRONMENT.json"
}

# Validate deployment
validate_deployment() {
    print_status "Validating deployment..."
    
    # Test API endpoint
    API_ENDPOINT=$(cd "$TERRAFORM_DIR" && terraform output -raw api_endpoint)
    
    if curl -sf "$API_ENDPOINT/health" > /dev/null 2>&1; then
        print_status "API endpoint is responding"
    else
        print_warning "API endpoint may not be ready yet"
    fi
    
    print_status "Deployment validation completed"
    echo ""
}

# Main execution
main() {
    echo "Starting deployment process..."
    echo ""
    
    check_prerequisites
    init_terraform
    
    if plan_infrastructure; then
        if [ $? -eq 2 ]; then
            # Changes detected, prompt for confirmation
            echo ""
            read -p "Do you want to apply these changes? (y/N): " -n 1 -r
            echo ""
            
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                apply_infrastructure
                show_outputs
                validate_deployment
                
                print_status "🎉 Deployment completed successfully!"
                echo ""
                echo "Next steps:"
                echo "1. Update your frontend configuration with the API endpoint"
                echo "2. Deploy Lambda function code"
                echo "3. Test the upload functionality"
                echo ""
            else
                print_warning "Deployment cancelled by user"
                exit 0
            fi
        else
            print_status "No changes to apply"
            show_outputs
        fi
    else
        print_error "Planning failed"
        exit 1
    fi
}

# Handle script arguments
case "${1:-}" in
    "plan")
        check_prerequisites
        init_terraform
        plan_infrastructure
        ;;
    "apply")
        check_prerequisites
        init_terraform
        apply_infrastructure
        show_outputs
        validate_deployment
        ;;
    "destroy")
        print_warning "This will destroy ALL infrastructure!"
        read -p "Are you absolutely sure? (type 'yes'): " -r
        if [ "$REPLY" = "yes" ]; then
            cd "$TERRAFORM_DIR"
            terraform destroy -var="environment=$ENVIRONMENT"
        else
            print_warning "Destruction cancelled"
        fi
        ;;
    "outputs")
        cd "$TERRAFORM_DIR"
        show_outputs
        ;;
    "validate")
        validate_deployment
        ;;
    *)
        main
        ;;
esac