output "upload_bucket_name" {
  description = "Name of the S3 upload bucket"
  value       = aws_s3_bucket.upload_bucket.bucket
}

output "upload_bucket_arn" {
  description = "ARN of the S3 upload bucket"
  value       = aws_s3_bucket.upload_bucket.arn
}

output "upload_table_name" {
  description = "Name of the DynamoDB upload table"
  value       = aws_dynamodb_table.upload_queue.name
}

output "upload_table_arn" {
  description = "ARN of the DynamoDB upload table"
  value       = aws_dynamodb_table.upload_queue.arn
}