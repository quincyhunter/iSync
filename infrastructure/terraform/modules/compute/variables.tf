variable "environment" {
  description = "Environment name"
  type        = string
}

variable "account_id" {
  description = "AWS Account ID"
  type        = string
}

variable "upload_bucket" {
  description = "S3 upload bucket name"
  type        = string
}

variable "upload_bucket_arn" {
  description = "S3 upload bucket ARN"
  type        = string
}

variable "upload_table" {
  description = "DynamoDB upload table name"
  type        = string
}

variable "upload_table_arn" {
  description = "DynamoDB upload table ARN"
  type        = string
}

variable "queue_url" {
  description = "SQS queue URL"
  type        = string
}

variable "queue_arn" {
  description = "SQS queue ARN"
  type        = string
}

variable "ec2_instance_type" {
  description = "EC2 instance type for processing"
  type        = string
  default     = "t2.micro"
}

variable "log_retention_days" {
  description = "CloudWatch logs retention period in days"
  type        = number
  default     = 14
}