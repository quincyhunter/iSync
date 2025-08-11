data "aws_ami" "windows" {
  most_recent = true
  owners      = ["801119661308"] # Amazon

  filter {
    name   = "name"
    values = ["Windows_Server-2022-English-Full-Base-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_security_group" "processing_instance" {
  name_prefix = "isync-processing-${var.environment}-"
  description = "Security group for iSync music processing instances"

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Allow RDP for debugging (can be removed in production)
  ingress {
    from_port   = 3389
    to_port     = 3389
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "iSync Processing Security Group"
    Environment = var.environment
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_launch_template" "processing_instance" {
  name_prefix   = "isync-processing-${var.environment}-"
  description   = "Launch template for iSync music processing instances"
  image_id      = var.ami_id
  instance_type = var.instance_type
  key_name      = "isync-keypair"

  vpc_security_group_ids = [aws_security_group.processing_instance.id]

  iam_instance_profile {
    name = var.instance_profile_name
  }

  user_data = base64encode(templatefile("${path.module}/user_data.ps1", {
    environment        = var.environment
    queue_url         = var.queue_url
    upload_bucket     = var.upload_bucket
    upload_table      = var.upload_table
    aws_region        = var.aws_region
  }))

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name        = "iSync Processing Instance"
      Environment = var.environment
      Purpose     = "MusicProcessing"
    }
  }

  tag_specifications {
    resource_type = "volume"
    tags = {
      Name        = "iSync Processing Volume"
      Environment = var.environment
    }
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name        = "iSync Processing Launch Template"
    Environment = var.environment
  }
}

resource "aws_autoscaling_group" "processing_instances" {
  name                = "isync-processing-asg-${var.environment}"
  vpc_zone_identifier = var.subnet_ids
  target_group_arns   = []
  health_check_type   = "EC2"
  
  min_size         = 0
  max_size         = 2
  desired_capacity = 0

  launch_template {
    id      = aws_launch_template.processing_instance.id
    version = "$Latest"
  }

  # Scale down quickly when not needed
  default_cooldown          = 300
  health_check_grace_period = 300

  tag {
    key                 = "Name"
    value               = "iSync Processing ASG"
    propagate_at_launch = false
  }

  tag {
    key                 = "Environment"
    value               = var.environment
    propagate_at_launch = true
  }

  tag {
    key                 = "Purpose"
    value               = "MusicProcessing"
    propagate_at_launch = true
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_autoscaling_policy" "scale_up" {
  name                   = "isync-scale-up-${var.environment}"
  scaling_adjustment     = 1
  adjustment_type        = "ChangeInCapacity"
  cooldown               = 300
  autoscaling_group_name = aws_autoscaling_group.processing_instances.name
}

resource "aws_autoscaling_policy" "scale_down" {
  name                   = "isync-scale-down-${var.environment}"
  scaling_adjustment     = -1
  adjustment_type        = "ChangeInCapacity"
  cooldown               = 300
  autoscaling_group_name = aws_autoscaling_group.processing_instances.name
}

# CloudWatch alarms for auto scaling
resource "aws_cloudwatch_metric_alarm" "queue_high" {
  alarm_name          = "isync-queue-high-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "ApproximateNumberOfVisibleMessages"
  namespace           = "AWS/SQS"
  period              = "300"
  statistic           = "Average"
  threshold           = "10"
  alarm_description   = "This metric monitors SQS queue depth for scaling up"
  alarm_actions       = [aws_autoscaling_policy.scale_up.arn]

  dimensions = {
    QueueName = var.queue_name
  }
}

resource "aws_cloudwatch_metric_alarm" "queue_low" {
  alarm_name          = "isync-queue-low-${var.environment}"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = "3"
  metric_name         = "ApproximateNumberOfVisibleMessages"
  namespace           = "AWS/SQS"
  period              = "300"
  statistic           = "Average"
  threshold           = "2"
  alarm_description   = "This metric monitors SQS queue depth for scaling down"
  alarm_actions       = [aws_autoscaling_policy.scale_down.arn]

  dimensions = {
    QueueName = var.queue_name
  }
}


