data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect = "Allow"
    
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    
    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "lambda_execution_role" {
  name               = "isync-lambda-execution-role-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = {
    Name        = "iSync Lambda Execution Role"
    Environment = var.environment
  }
}

data "aws_iam_policy_document" "lambda_permissions" {
  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = ["arn:aws:logs:*:*:*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObjectVersion"
    ]
    resources = ["${var.upload_bucket_arn}/*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "s3:ListBucket"
    ]
    resources = [var.upload_bucket_arn]
  }

  statement {
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan"
    ]
    resources = [
      var.upload_table_arn,
      "${var.upload_table_arn}/index/*"
    ]
  }

  statement {
    effect = "Allow"
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes"
    ]
    resources = [var.queue_arn]
  }

  statement {
    effect = "Allow"
    actions = [
      "ec2:DescribeInstances",
      "ec2:StartInstances",
      "ec2:StopInstances",
      "ec2:RunInstances",
      "ec2:TerminateInstances"
    ]
    resources = ["*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "iam:PassRole"
    ]
    resources = [aws_iam_role.ec2_role.arn]
  }

  statement {
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue"
    ]
    resources = ["arn:aws:secretsmanager:*:*:secret:isync/*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords"
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "lambda_permissions" {
  name   = "isync-lambda-permissions-${var.environment}"
  policy = data.aws_iam_policy_document.lambda_permissions.json
}

resource "aws_iam_role_policy_attachment" "lambda_permissions" {
  role       = aws_iam_role.lambda_execution_role.name
  policy_arn = aws_iam_policy.lambda_permissions.arn
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "upload_handler" {
  filename         = "${path.module}/../../backend/dist/upload-handler.zip"
  function_name    = "isync-upload-handler-${var.environment}"
  role            = aws_iam_role.lambda_execution_role.arn
  handler         = "index.handler"
  source_code_hash = filebase64sha256("${path.module}/../../backend/dist/upload-handler.zip")
  runtime         = "nodejs18.x"
  timeout         = 30
  memory_size     = 512

  environment {
    variables = {
      ENVIRONMENT        = var.environment
      UPLOAD_BUCKET     = var.upload_bucket
      UPLOAD_TABLE      = var.upload_table
      QUEUE_URL         = var.queue_url
      NODE_OPTIONS      = "--enable-source-maps"
    }
  }

  tracing_config {
    mode = "Active"
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  tags = {
    Name        = "iSync Upload Handler"
    Environment = var.environment
  }
}

resource "aws_lambda_function" "metadata_processor" {
  filename         = "${path.module}/../../backend/dist/metadata-processor.zip"
  function_name    = "isync-metadata-processor-${var.environment}"
  role            = aws_iam_role.lambda_execution_role.arn
  handler         = "index.handler"
  source_code_hash = filebase64sha256("${path.module}/../../backend/dist/metadata-processor.zip")
  runtime         = "nodejs18.x"
  timeout         = 60
  memory_size     = 256

  environment {
    variables = {
      ENVIRONMENT        = var.environment
      UPLOAD_BUCKET     = var.upload_bucket
      UPLOAD_TABLE      = var.upload_table
      NODE_OPTIONS      = "--enable-source-maps"
    }
  }

  tracing_config {
    mode = "Active"
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  tags = {
    Name        = "iSync Metadata Processor"
    Environment = var.environment
  }
}

resource "aws_lambda_function" "queue_manager" {
  filename         = "${path.module}/../../backend/dist/queue-manager.zip"
  function_name    = "isync-queue-manager-${var.environment}"
  role            = aws_iam_role.lambda_execution_role.arn
  handler         = "index.handler"
  source_code_hash = filebase64sha256("${path.module}/../../backend/dist/queue-manager.zip")
  runtime         = "nodejs18.x"
  timeout         = 300
  memory_size     = 256

  environment {
    variables = {
      ENVIRONMENT        = var.environment
      QUEUE_URL         = var.queue_url
      UPLOAD_TABLE      = var.upload_table
      NODE_OPTIONS      = "--enable-source-maps"
    }
  }

  tracing_config {
    mode = "Active"
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  tags = {
    Name        = "iSync Queue Manager"
    Environment = var.environment
  }
}

resource "aws_lambda_function" "ec2_controller" {
  filename         = "${path.module}/../../backend/dist/ec2-controller.zip"
  function_name    = "isync-ec2-controller-${var.environment}"
  role            = aws_iam_role.lambda_execution_role.arn
  handler         = "index.handler"
  source_code_hash = filebase64sha256("${path.module}/../../backend/dist/ec2-controller.zip")
  runtime         = "nodejs18.x"
  timeout         = 300
  memory_size     = 256

  environment {
    variables = {
      ENVIRONMENT        = var.environment
      EC2_INSTANCE_TYPE = var.ec2_instance_type
      NODE_OPTIONS      = "--enable-source-maps"
    }
  }

  tracing_config {
    mode = "Active"
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  tags = {
    Name        = "iSync EC2 Controller"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "lambda_logs" {
  for_each = {
    upload_handler      = aws_lambda_function.upload_handler.function_name
    metadata_processor  = aws_lambda_function.metadata_processor.function_name
    queue_manager      = aws_lambda_function.queue_manager.function_name
    ec2_controller     = aws_lambda_function.ec2_controller.function_name
  }

  name              = "/aws/lambda/${each.value}"
  retention_in_days = var.log_retention_days

  tags = {
    Name        = "iSync Lambda Logs - ${each.key}"
    Environment = var.environment
  }
}

# EC2 Role for processing instances
data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    effect = "Allow"
    
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
    
    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "ec2_role" {
  name               = "isync-ec2-role-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json

  tags = {
    Name        = "iSync EC2 Role"
    Environment = var.environment
  }
}

data "aws_iam_policy_document" "ec2_permissions" {
  statement {
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject"
    ]
    resources = ["${var.upload_bucket_arn}/*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "dynamodb:UpdateItem",
      "dynamodb:GetItem"
    ]
    resources = [var.upload_table_arn]
  }

  statement {
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes"
    ]
    resources = [var.queue_arn]
  }

  statement {
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue"
    ]
    resources = ["arn:aws:secretsmanager:*:*:secret:isync/*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = ["arn:aws:logs:*:*:*"]
  }
}

resource "aws_iam_policy" "ec2_permissions" {
  name   = "isync-ec2-permissions-${var.environment}"
  policy = data.aws_iam_policy_document.ec2_permissions.json
}

resource "aws_iam_role_policy_attachment" "ec2_permissions" {
  role       = aws_iam_role.ec2_role.name
  policy_arn = aws_iam_policy.ec2_permissions.arn
}

resource "aws_iam_instance_profile" "ec2_profile" {
  name = "isync-ec2-profile-${var.environment}"
  role = aws_iam_role.ec2_role.name
}