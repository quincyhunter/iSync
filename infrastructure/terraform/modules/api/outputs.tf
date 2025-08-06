output "api_endpoint" {
  description = "API Gateway endpoint URL"
  value       = "https://${aws_api_gateway_rest_api.isync_api.id}.execute-api.${data.aws_region.current.name}.amazonaws.com/${var.environment}"
}

output "api_id" {
  description = "API Gateway ID"
  value       = aws_api_gateway_rest_api.isync_api.id
}

output "api_arn" {
  description = "API Gateway ARN"
  value       = aws_api_gateway_rest_api.isync_api.arn
}

data "aws_region" "current" {}