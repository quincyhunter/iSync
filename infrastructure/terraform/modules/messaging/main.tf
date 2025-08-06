resource "aws_sqs_queue" "upload_queue" {
  name                       = "isync-upload-queue-${var.environment}"
  delay_seconds              = 0
  max_message_size           = 262144
  message_retention_seconds  = 1209600
  receive_wait_time_seconds  = 10
  visibility_timeout_seconds = 300

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.upload_dlq.arn
    maxReceiveCount     = 3
  })

  tags = {
    Name        = "iSync Upload Queue"
    Environment = var.environment
  }
}

resource "aws_sqs_queue" "upload_dlq" {
  name                       = "isync-upload-dlq-${var.environment}"
  message_retention_seconds  = 1209600

  tags = {
    Name        = "iSync Upload Dead Letter Queue"
    Environment = var.environment
  }
}

resource "aws_sqs_queue_policy" "upload_queue_policy" {
  queue_url = aws_sqs_queue.upload_queue.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "events.amazonaws.com"
        }
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.upload_queue.arn
      }
    ]
  })
}

resource "aws_cloudwatch_event_rule" "processing_schedule" {
  name                = "isync-processing-schedule-${var.environment}"
  description         = "Trigger EC2 processing every 6 hours"
  schedule_expression = "rate(6 hours)"

  tags = {
    Name        = "iSync Processing Schedule"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_event_rule" "queue_depth_alarm" {
  name        = "isync-queue-depth-alarm-${var.environment}"
  description = "Trigger when queue depth reaches threshold"

  event_pattern = jsonencode({
    source      = ["aws.sqs"]
    detail-type = ["SQS Queue Depth Alarm"]
    detail = {
      queue-name = [aws_sqs_queue.upload_queue.name]
    }
  })

  tags = {
    Name        = "iSync Queue Depth Alarm"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_metric_alarm" "queue_depth" {
  alarm_name          = "isync-queue-depth-${var.environment}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "ApproximateNumberOfVisibleMessages"
  namespace           = "AWS/SQS"
  period              = "300"
  statistic           = "Average"
  threshold           = "10"
  alarm_description   = "This metric monitors SQS queue depth"
  alarm_actions       = [aws_sns_topic.processing_alerts.arn]

  dimensions = {
    QueueName = aws_sqs_queue.upload_queue.name
  }

  tags = {
    Name        = "iSync Queue Depth Alarm"
    Environment = var.environment
  }
}

resource "aws_sns_topic" "processing_alerts" {
  name = "isync-processing-alerts-${var.environment}"

  tags = {
    Name        = "iSync Processing Alerts"
    Environment = var.environment
  }
}