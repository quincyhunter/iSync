terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket  = "isync-terraform-state"
    key     = "prod/terraform.tfstate"
    region  = "us-east-1"
    encrypt = true
  }
}

provider "aws" {
  region = var.aws_region
  
  default_tags {
    tags = {
      Project     = "iSync-Music-Manager"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
  
  common_tags = {
    Project     = "iSync-Music-Manager"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}

module "storage" {
  source = "./modules/storage"
  
  environment = var.environment
  account_id  = local.account_id
}

module "messaging" {
  source = "./modules/messaging"
  
  environment = var.environment
}

module "compute" {
  source = "./modules/compute"
  
  environment        = var.environment
  account_id         = local.account_id
  upload_bucket      = module.storage.upload_bucket_name
  upload_bucket_arn  = module.storage.upload_bucket_arn
  upload_table       = module.storage.upload_table_name
  upload_table_arn   = module.storage.upload_table_arn
  queue_url          = module.messaging.queue_url
  queue_arn          = module.messaging.queue_arn
  ec2_instance_type  = var.ec2_instance_type
  log_retention_days = var.retention_days
}

module "api" {
  source = "./modules/api"
  
  environment           = var.environment
  lambda_invoke_arn     = module.compute.lambda_invoke_arn
  upload_handler_name   = module.compute.upload_handler_name
  queue_manager_name    = module.compute.queue_manager_name
}

module "ec2" {
  source = "./modules/ec2"
  
  environment              = var.environment
  instance_type           = var.ec2_instance_type
  instance_profile_name   = module.compute.ec2_instance_profile_name
  subnet_ids              = data.aws_subnets.default.ids
  queue_url               = module.messaging.queue_url
  queue_name              = split("/", module.messaging.queue_url)[4]
  upload_bucket           = module.storage.upload_bucket_name
  upload_table            = module.storage.upload_table_name
  processing_schedule_arn = module.messaging.processing_schedule_arn
  aws_region              = var.aws_region
}

module "monitoring" {
  source = "./modules/monitoring"
  
  environment             = var.environment
  api_id                  = module.api.api_id
  api_name                = "isync-api-${var.environment}"
  lambda_arns             = module.compute.lambda_arns
  lambda_function_names = {
    upload_handler     = module.compute.upload_handler_name
    metadata_processor = module.compute.metadata_processor_name
    queue_manager     = module.compute.queue_manager_name
    ec2_controller    = module.compute.ec2_controller_name
  }
  queue_name            = split("/", module.messaging.queue_url)[4]
  dynamodb_table_name   = module.storage.upload_table_name
  log_retention_days    = var.retention_days
}