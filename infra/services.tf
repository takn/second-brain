# Created manually per docs/connector-setup.md; referenced here so the worker
# (and web ownership DMs) get tokens without Terraform ever holding secret values.
data "aws_secretsmanager_secret" "slack" {
  name = "${var.prefix}/slack"
}

data "aws_secretsmanager_secret" "gitlab" {
  name = "${var.prefix}/gitlab"
}

data "aws_secretsmanager_secret" "jira" {
  name = "${var.prefix}/jira"
}

# Google OAuth client for the web SSO gate (oauth2-proxy in the web image) —
# the app's sole IdP. Created manually per docs/connector-setup.md §6;
# referenced here so Terraform never holds the secret values.
data "aws_secretsmanager_secret" "google_oauth" {
  name = "${var.prefix}/google-oauth"
}

# Web: App Runner pulling from ECR, connected to the VPC for RDS access.
resource "aws_apprunner_service" "web" {
  service_name = "${var.prefix}-web"

  source_configuration {
    auto_deployments_enabled = false # CI triggers deployments explicitly

    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_ecr.arn
    }

    image_repository {
      image_repository_type = "ECR"
      image_identifier      = "${aws_ecr_repository.web.repository_url}:latest"

      image_configuration {
        port = "3000"
        runtime_environment_secrets = {
          DATABASE_URL = aws_secretsmanager_secret.database_url.arn
          # Full secret JSON; the webhook route reads .webhook_secret.
          GITLAB_CONNECTOR_SECRET = data.aws_secretsmanager_secret.gitlab.arn
          # One-click Jira issue creation from untracked work (task 5.8).
          JIRA_API_TOKEN = "${data.aws_secretsmanager_secret.jira.arn}:api_token::"
          JIRA_CLOUD_ID  = "${data.aws_secretsmanager_secret.jira.arn}:cloud_id::"
          # Project POC assign/clear notifications (assign-project-pocs).
          SLACK_BOT_TOKEN = "${data.aws_secretsmanager_secret.slack.arn}:bot_token::"
          # The :key:: suffix extracts a single JSON key from the secret.
          OAUTH2_PROXY_CLIENT_ID     = "${data.aws_secretsmanager_secret.google_oauth.arn}:client_id::"
          OAUTH2_PROXY_CLIENT_SECRET = "${data.aws_secretsmanager_secret.google_oauth.arn}:client_secret::"
          OAUTH2_PROXY_COOKIE_SECRET = "${data.aws_secretsmanager_secret.google_oauth.arn}:cookie_secret::"
        }
        runtime_environment_variables = {
          S3_REGION                  = var.region
          S3_BUCKET_RAW              = aws_s3_bucket.raw.bucket
          SQS_QUEUE_JOBS             = aws_sqs_queue.jobs.name
          OAUTH2_PROXY_EMAIL_DOMAINS = var.google_workspace_domain
          # Dev-phase: everyone is L1 until the L1 Google group exists;
          # flip to "L2" (or drop) at rollout (7.5).
          ROLE_DEFAULT   = var.web_default_role
          L1_GROUP_EMAIL = var.l1_group_email
        }
      }
    }
  }

  instance_configuration {
    cpu               = var.web_cpu
    memory            = var.web_memory
    instance_role_arn = aws_iam_role.web.arn
  }

  network_configuration {
    egress_configuration {
      egress_type       = "VPC"
      vpc_connector_arn = aws_apprunner_vpc_connector.main.arn
    }
  }

  # TCP gate: service is "up" when the port accepts connections. The deep
  # /api/health endpoint (db/storage/queue) is for monitoring, not liveness —
  # gating on it would deadlock creation if any dependency hiccups.
  health_check_configuration {
    protocol = "TCP"
  }
}

# Worker: single Fargate service polling SQS.
resource "aws_ecs_cluster" "main" {
  name = var.prefix
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${var.prefix}-worker"
  retention_in_days = 30
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.prefix}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  task_role_arn            = aws_iam_role.worker_task.arn
  execution_role_arn       = aws_iam_role.worker_execution.arn

  container_definitions = jsonencode([{
    name      = "worker"
    image     = "${aws_ecr_repository.worker.repository_url}:latest"
    essential = true
    secrets = concat(
      [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
        { name = "SLACK_BOT_TOKEN", valueFrom = "${data.aws_secretsmanager_secret.slack.arn}:bot_token::" },
        { name = "GITLAB_TOKEN", valueFrom = "${data.aws_secretsmanager_secret.gitlab.arn}:token::" },
        { name = "JIRA_API_TOKEN", valueFrom = "${data.aws_secretsmanager_secret.jira.arn}:api_token::" },
        { name = "JIRA_CLOUD_ID", valueFrom = "${data.aws_secretsmanager_secret.jira.arn}:cloud_id::" },
      ],
      length(data.aws_secretsmanager_secret.email) > 0 ? [
        { name = "EMAIL_FROM", valueFrom = "${data.aws_secretsmanager_secret.email[0].arn}:from::" },
      ] : [],
    )
    environment = [
      { name = "S3_REGION", value = var.region },
      { name = "S3_BUCKET_RAW", value = aws_s3_bucket.raw.bucket },
      { name = "SQS_QUEUE_JOBS", value = aws_sqs_queue.jobs.name },
      { name = "SLACK_TEAM_IDS", value = var.slack_team_ids },
      { name = "SLACK_CHANNEL_ALLOWLIST", value = var.slack_channel_allowlist },
      { name = "SLACK_BACKFILL_DAYS", value = var.slack_backfill_days },
      { name = "JIRA_SYNC_DISABLED", value = var.jira_sync_disabled },
      { name = "GWS_DOMAIN", value = var.google_workspace_domain },
      { name = "GITLAB_ROOT_GROUP", value = var.gitlab_root_group },
      { name = "TRIAGE_THRESHOLD", value = var.triage_threshold },
      # Daily digest (task 5.9): deep links point at the web app; DMs stay
      # allowlist-gated until the org rollout (7.5).
      { name = "APP_BASE_URL", value = "https://${aws_apprunner_service.web.service_url}" },
      { name = "DIGEST_ENABLED", value = var.digest_enabled },
      { name = "DIGEST_ALLOWLIST", value = var.digest_allowlist },
      { name = "DIGEST_HOUR_UTC", value = var.digest_hour_utc },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.worker.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "worker"
      }
    }
  }])
}

resource "aws_ecs_service" "worker" {
  name            = "${var.prefix}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.worker.id]
  }
}
