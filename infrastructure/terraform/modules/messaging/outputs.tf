output "queue_url" {
  description = "SQS queue URL"
  value       = aws_sqs_queue.upload_queue.url
}

output "queue_arn" {
  description = "SQS queue ARN"
  value       = aws_sqs_queue.upload_queue.arn
}

output "dlq_url" {
  description = "Dead letter queue URL"
  value       = aws_sqs_queue.upload_dlq.url
}

output "dlq_arn" {
  description = "Dead letter queue ARN"
  value       = aws_sqs_queue.upload_dlq.arn
}

output "processing_schedule_arn" {
  description = "EventBridge processing schedule ARN"
  value       = aws_cloudwatch_event_rule.processing_schedule.arn
}

output "sns_topic_arn" {
  description = "SNS topic ARN for alerts"
  value       = aws_sns_topic.processing_alerts.arn
}