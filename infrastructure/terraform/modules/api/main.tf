resource "aws_api_gateway_rest_api" "isync_api" {
  name        = "isync-api-${var.environment}"
  description = "iSync Music Manager API"

  endpoint_configuration {
    types = ["REGIONAL"]
  }

  tags = {
    Name        = "iSync API Gateway"
    Environment = var.environment
  }
}

resource "aws_api_gateway_deployment" "isync_api" {
  depends_on = [
    aws_api_gateway_method.upload_post,
    aws_api_gateway_method.upload_get,
    aws_api_gateway_method.library_get,
    aws_api_gateway_method.auth_post,
    aws_api_gateway_method.upload_delete,
  ]

  rest_api_id = aws_api_gateway_rest_api.isync_api.id
  stage_name  = var.environment

  lifecycle {
    create_before_destroy = true
  }

  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.upload.id,
      aws_api_gateway_resource.library.id,
      aws_api_gateway_resource.auth.id,
      aws_api_gateway_method.upload_post.id,
      aws_api_gateway_method.upload_get.id,
      aws_api_gateway_method.library_get.id,
      aws_api_gateway_method.auth_post.id,
      aws_api_gateway_method.upload_delete.id,
      aws_api_gateway_integration.upload_post.id,
      aws_api_gateway_integration.upload_get.id,
      aws_api_gateway_integration.library_get.id,
      aws_api_gateway_integration.auth_post.id,
      aws_api_gateway_integration.upload_delete.id,
    ]))
  }
}

resource "aws_api_gateway_stage" "isync_api" {
  deployment_id = aws_api_gateway_deployment.isync_api.id
  rest_api_id   = aws_api_gateway_rest_api.isync_api.id
  stage_name    = var.environment

  xray_tracing_enabled = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_logs.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      caller         = "$context.identity.caller"
      user           = "$context.identity.user"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      resourcePath   = "$context.resourcePath"
      status         = "$context.status"
      protocol       = "$context.protocol"
      responseLength = "$context.responseLength"
    })
  }

  tags = {
    Name        = "iSync API Stage"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "api_logs" {
  name              = "/aws/apigateway/isync-${var.environment}"
  retention_in_days = 14

  tags = {
    Name        = "iSync API Gateway Logs"
    Environment = var.environment
  }
}

# CORS configuration
resource "aws_api_gateway_method" "options" {
  for_each = {
    upload  = aws_api_gateway_resource.upload.id
    library = aws_api_gateway_resource.library.id
    auth    = aws_api_gateway_resource.auth.id
  }

  rest_api_id   = aws_api_gateway_rest_api.isync_api.id
  resource_id   = each.value
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "options" {
  for_each = aws_api_gateway_method.options

  rest_api_id = aws_api_gateway_rest_api.isync_api.id
  resource_id = each.value.resource_id
  http_method = each.value.http_method

  type = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "options" {
  for_each = aws_api_gateway_method.options

  rest_api_id = aws_api_gateway_rest_api.isync_api.id
  resource_id = each.value.resource_id
  http_method = each.value.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "options" {
  for_each = aws_api_gateway_method.options

  rest_api_id = aws_api_gateway_rest_api.isync_api.id
  resource_id = each.value.resource_id
  http_method = each.value.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'"
    "method.response.header.Access-Control-Allow-Methods" = "'GET,OPTIONS,POST,PUT,DELETE'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }

  depends_on = [aws_api_gateway_method_response.options]
}

# API Resources
resource "aws_api_gateway_resource" "upload" {
  rest_api_id = aws_api_gateway_rest_api.isync_api.id
  parent_id   = aws_api_gateway_rest_api.isync_api.root_resource_id
  path_part   = "upload"
}

resource "aws_api_gateway_resource" "upload_id" {
  rest_api_id = aws_api_gateway_rest_api.isync_api.id
  parent_id   = aws_api_gateway_resource.upload.id
  path_part   = "{id}"
}

resource "aws_api_gateway_resource" "library" {
  rest_api_id = aws_api_gateway_rest_api.isync_api.id
  parent_id   = aws_api_gateway_rest_api.isync_api.root_resource_id
  path_part   = "library"
}

resource "aws_api_gateway_resource" "auth" {
  rest_api_id = aws_api_gateway_rest_api.isync_api.id
  parent_id   = aws_api_gateway_rest_api.isync_api.root_resource_id
  path_part   = "auth"
}

# Methods and Integrations
# POST /upload
resource "aws_api_gateway_method" "upload_post" {
  rest_api_id   = aws_api_gateway_rest_api.isync_api.id
  resource_id   = aws_api_gateway_resource.upload.id
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "upload_post" {
  rest_api_id = aws_api_gateway_rest_api.isync_api.id
  resource_id = aws_api_gateway_resource.upload.id
  http_method = aws_api_gateway_method.upload_post.http_method

  integration_http_method = "POST"
  type                   = "AWS_PROXY"
  uri                    = var.lambda_invoke_arn.upload_handler
}

# GET /upload/{id}
resource "aws_api_gateway_method" "upload_get" {
  rest_api_id   = aws_api_gateway_rest_api.isync_api.id
  resource_id   = aws_api_gateway_resource.upload_id.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "upload_get" {
  rest_api_id = aws_api_gateway_rest_api.isync_api.id
  resource_id = aws_api_gateway_resource.upload_id.id
  http_method = aws_api_gateway_method.upload_get.http_method

  integration_http_method = "POST"
  type                   = "AWS_PROXY"
  uri                    = var.lambda_invoke_arn.upload_handler
}

# DELETE /upload/{id}
resource "aws_api_gateway_method" "upload_delete" {
  rest_api_id   = aws_api_gateway_rest_api.isync_api.id
  resource_id   = aws_api_gateway_resource.upload_id.id
  http_method   = "DELETE"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "upload_delete" {
  rest_api_id = aws_api_gateway_rest_api.isync_api.id
  resource_id = aws_api_gateway_resource.upload_id.id
  http_method = aws_api_gateway_method.upload_delete.http_method

  integration_http_method = "POST"
  type                   = "AWS_PROXY"
  uri                    = var.lambda_invoke_arn.upload_handler
}

# GET /library
resource "aws_api_gateway_method" "library_get" {
  rest_api_id   = aws_api_gateway_rest_api.isync_api.id
  resource_id   = aws_api_gateway_resource.library.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "library_get" {
  rest_api_id = aws_api_gateway_rest_api.isync_api.id
  resource_id = aws_api_gateway_resource.library.id
  http_method = aws_api_gateway_method.library_get.http_method

  integration_http_method = "POST"
  type                   = "AWS_PROXY"
  uri                    = var.lambda_invoke_arn.queue_manager
}

# POST /auth
resource "aws_api_gateway_method" "auth_post" {
  rest_api_id   = aws_api_gateway_rest_api.isync_api.id
  resource_id   = aws_api_gateway_resource.auth.id
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "auth_post" {
  rest_api_id = aws_api_gateway_rest_api.isync_api.id
  resource_id = aws_api_gateway_resource.auth.id
  http_method = aws_api_gateway_method.auth_post.http_method

  integration_http_method = "POST"
  type                   = "AWS_PROXY"
  uri                    = var.lambda_invoke_arn.upload_handler
}

# Lambda permissions
resource "aws_lambda_permission" "api_gateway_upload" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.upload_handler_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.isync_api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "api_gateway_queue" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.queue_manager_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.isync_api.execution_arn}/*/*"
}