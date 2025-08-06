variable "environment" {
  description = "Environment name"
  type        = string
}

variable "api_id" {
  description = "API Gateway ID"
  type        = string
}

variable "api_name" {
  description = "API Gateway name"
  type        = string
  default     = ""
}

variable "lambda_arns" {
  description = "Lambda function ARNs"
  type = object({
    upload_handler     = string
    metadata_processor = string
    queue_manager     = string
    ec2_controller    = string
  })
}

variable "lambda_function_names" {
  description = "Lambda function names"
  type = object({
    upload_handler     = string
    metadata_processor = string
    queue_manager     = string
    ec2_controller    = string
  })
  default = {
    upload_handler     = ""
    metadata_processor = ""
    queue_manager     = ""
    ec2_controller    = ""
  }
}

variable "queue_name" {
  description = "SQS queue name"
  type        = string
  default     = ""
}

variable "dynamodb_table_name" {
  description = "DynamoDB table name"
  type        = string
  default     = ""
}

variable "log_retention_days" {
  description = "CloudWatch logs retention period in days"
  type        = number
  default     = 14
}