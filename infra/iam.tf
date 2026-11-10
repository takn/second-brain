data "aws_iam_policy_document" "app_permissions" {
  statement {
    sid       = "RawBucket"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.raw.arn, "${aws_s3_bucket.raw.arn}/*"]
  }

  statement {
    sid = "JobsQueue"
    actions = [
      "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage",
      "sqs:GetQueueUrl", "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.jobs.arn, aws_sqs_queue.jobs_dlq.arn]
  }

  statement {
    sid       = "AppSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:${var.prefix}/*"]
  }

  # Agent LLM calls (brain-agents: tiered Bedrock routing). Cross-region
  # inference profiles require BOTH the profile ARN and wildcard-region
  # foundation-model ARNs, since requests route to any region in the profile.
  statement {
    sid     = "BedrockInvoke"
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = [
      "arn:aws:bedrock:*::foundation-model/anthropic.*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/us.anthropic.*",
    ]
  }

  # Outbound workflow email (task 7.1): SES SendEmail, IAM-brokered.
  dynamic "statement" {
    for_each = var.email_from != "" ? [1] : []
    content {
      sid       = "SesSend"
      actions   = ["ses:SendEmail", "ses:SendRawEmail"]
      resources = ["*"]
      condition {
        test     = "StringEquals"
        variable = "ses:FromAddress"
        values   = [var.email_from]
      }
    }
  }
}

resource "aws_iam_policy" "app" {
  name   = "${var.prefix}-app"
  policy = data.aws_iam_policy_document.app_permissions.json
}

# --- App Runner instance role (web) ---
resource "aws_iam_role" "web" {
  name = "${var.prefix}-web"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "tasks.apprunner.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "web_app" {
  role       = aws_iam_role.web.name
  policy_arn = aws_iam_policy.app.arn
}

# App Runner ECR access role (pull images).
resource "aws_iam_role" "apprunner_ecr" {
  name = "${var.prefix}-apprunner-ecr"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "build.apprunner.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "apprunner_ecr" {
  role       = aws_iam_role.apprunner_ecr.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

# --- Fargate task + execution roles (worker) ---
resource "aws_iam_role" "worker_task" {
  name = "${var.prefix}-worker-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "worker_app" {
  role       = aws_iam_role.worker_task.name
  policy_arn = aws_iam_policy.app.arn
}

resource "aws_iam_role" "worker_execution" {
  name               = "${var.prefix}-worker-execution"
  assume_role_policy = aws_iam_role.worker_task.assume_role_policy
}

resource "aws_iam_role_policy_attachment" "worker_execution" {
  role       = aws_iam_role.worker_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Execution role also reads secrets injected as container env vars.
resource "aws_iam_role_policy" "worker_execution_secrets" {
  name = "secrets"
  role = aws_iam_role.worker_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:${var.prefix}/*"
    }]
  })
}
