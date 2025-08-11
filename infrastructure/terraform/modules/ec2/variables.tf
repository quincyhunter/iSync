variable "environment" {
  description = "Environment name"
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t2.micro"
}

variable "instance_profile_name" {
  description = "IAM instance profile name"
  type        = string
}

variable "subnet_ids" {
  description = "Subnet IDs for the Auto Scaling Group"
  type        = list(string)
  default     = []
}

variable "queue_url" {
  description = "SQS queue URL"
  type        = string
}

variable "queue_name" {
  description = "SQS queue name"
  type        = string
}

variable "upload_bucket" {
  description = "S3 upload bucket name"
  type        = string
}

variable "upload_table" {
  description = "DynamoDB upload table name"
  type        = string
}

variable "processing_schedule_arn" {
  description = "EventBridge processing schedule ARN"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "ami_id" {
  description = "AMI ID for the Windows iTunes/processor image"
  type        = string
}