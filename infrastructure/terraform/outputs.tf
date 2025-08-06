output "api_endpoint" {
  description = "API Gateway endpoint URL"
  value       = module.api.api_endpoint
}

output "upload_bucket_name" {
  description = "S3 bucket name for uploads"
  value       = module.storage.upload_bucket_name
}

output "upload_table_name" {
  description = "DynamoDB table name for upload metadata"
  value       = module.storage.upload_table_name
}

output "queue_url" {
  description = "SQS queue URL for processing jobs"
  value       = module.messaging.queue_url
}

output "lambda_functions" {
  description = "Lambda function information"
  value = {
    upload_handler    = module.compute.upload_handler_name
    metadata_processor = module.compute.metadata_processor_name
    queue_manager     = module.compute.queue_manager_name
    ec2_controller    = module.compute.ec2_controller_name
  }
}

output "cloudwatch_dashboard_url" {
  description = "CloudWatch dashboard URL"
  value       = module.monitoring.dashboard_url
}