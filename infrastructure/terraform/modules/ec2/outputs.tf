output "autoscaling_group_name" {
  description = "Auto Scaling Group name"
  value       = aws_autoscaling_group.processing_instances.name
}

output "autoscaling_group_arn" {
  description = "Auto Scaling Group ARN"
  value       = aws_autoscaling_group.processing_instances.arn
}

output "launch_template_id" {
  description = "Launch template ID"
  value       = aws_launch_template.processing_instance.id
}

output "security_group_id" {
  description = "Security group ID"
  value       = aws_security_group.processing_instance.id
}

output "scale_up_policy_arn" {
  description = "Scale up policy ARN"
  value       = aws_autoscaling_policy.scale_up.arn
}

output "scale_down_policy_arn" {
  description = "Scale down policy ARN"
  value       = aws_autoscaling_policy.scale_down.arn
}