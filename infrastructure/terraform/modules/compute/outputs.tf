output "lambda_invoke_arn" {
  description = "Lambda function invoke ARNs"
  value = {
    upload_handler     = aws_lambda_function.upload_handler.invoke_arn
    metadata_processor = aws_lambda_function.metadata_processor.invoke_arn
    queue_manager     = aws_lambda_function.queue_manager.invoke_arn
    ec2_controller    = aws_lambda_function.ec2_controller.invoke_arn
  }
}

output "lambda_arns" {
  description = "Lambda function ARNs"
  value = {
    upload_handler     = aws_lambda_function.upload_handler.arn
    metadata_processor = aws_lambda_function.metadata_processor.arn
    queue_manager     = aws_lambda_function.queue_manager.arn
    ec2_controller    = aws_lambda_function.ec2_controller.arn
  }
}

output "upload_handler_name" {
  description = "Upload handler function name"
  value       = aws_lambda_function.upload_handler.function_name
}

output "metadata_processor_name" {
  description = "Metadata processor function name"
  value       = aws_lambda_function.metadata_processor.function_name
}

output "queue_manager_name" {
  description = "Queue manager function name"
  value       = aws_lambda_function.queue_manager.function_name
}

output "ec2_controller_name" {
  description = "EC2 controller function name"
  value       = aws_lambda_function.ec2_controller.function_name
}

output "ec2_instance_profile_name" {
  description = "EC2 instance profile name"
  value       = aws_iam_instance_profile.ec2_profile.name
}

output "ec2_role_arn" {
  description = "EC2 role ARN"
  value       = aws_iam_role.ec2_role.arn
}