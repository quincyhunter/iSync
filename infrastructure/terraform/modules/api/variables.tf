variable "environment" {
  description = "Environment name"
  type        = string
}

variable "lambda_invoke_arn" {
  description = "Lambda function invoke ARNs"
  type = object({
    upload_handler     = string
    metadata_processor = string
    queue_manager     = string
    ec2_controller    = string
  })
}

variable "upload_handler_name" {
  description = "Upload handler function name"
  type        = string
}

variable "queue_manager_name" {
  description = "Queue manager function name"
  type        = string
}