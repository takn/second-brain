# CloudWatch baseline (foundation task 1.7) + ops dashboards/alarms (task 7.2).
# The worker emits EMF under second-brain/funnel and second-brain/llm.
# The worker log group lives in services.tf next to its task definition.

# App Runner creates these groups implicitly on first deploy with no
# retention; they are imported into state so retention is enforced here.
resource "aws_cloudwatch_log_group" "web_application" {
  name              = "/aws/apprunner/${aws_apprunner_service.web.service_name}/${aws_apprunner_service.web.service_id}/application"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "web_service" {
  name              = "/aws/apprunner/${aws_apprunner_service.web.service_name}/${aws_apprunner_service.web.service_id}/service"
  retention_in_days = 30
}

locals {
  apprunner_dims = [
    "ServiceName", aws_apprunner_service.web.service_name,
    "ServiceID", aws_apprunner_service.web.service_id,
  ]
}

# --- Alerting (LLM budget + queue/DLQ + funnel failures) ---

resource "aws_sns_topic" "alerts" {
  name         = "${var.prefix}-alerts"
  display_name = "second-brain alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.budget_alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.budget_alert_email
}

resource "aws_cloudwatch_metric_alarm" "llm_budget_deferred" {
  alarm_name          = "${var.prefix}-llm-budget-deferred"
  alarm_description   = "An agent exhausted its daily LLM budget cap; jobs are queuing with delay"
  namespace           = "second-brain/llm"
  metric_name         = "budget_deferred"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "jobs_dlq" {
  alarm_name          = "${var.prefix}-jobs-dlq"
  alarm_description   = "Jobs landed in the dead-letter queue — inspect and redrive"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.jobs_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "jobs_oldest_age" {
  alarm_name          = "${var.prefix}-jobs-oldest-age"
  alarm_description   = "Oldest job in the queue is older than 30 minutes — pipeline lag"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.jobs.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1800
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "funnel_failures" {
  alarm_name          = "${var.prefix}-funnel-failures"
  alarm_description   = "Funnel stage failures spiked (collect/normalize/triage/extract/…)"
  namespace           = "second-brain/funnel"
  metric_name         = "failed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "executor_refused" {
  alarm_name          = "${var.prefix}-executor-refused"
  alarm_description   = "Outbound executor refused an out-of-scope action — review executor_audit"
  namespace           = "second-brain/funnel"
  metric_name         = "executor_refused"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = var.prefix

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title  = "Web — requests and responses"
          region = var.region
          stat   = "Sum"
          period = 300
          metrics = [
            concat(["AWS/AppRunner", "Requests"], local.apprunner_dims),
            concat(["AWS/AppRunner", "2xxStatusResponses"], local.apprunner_dims),
            concat(["AWS/AppRunner", "4xxStatusResponses"], local.apprunner_dims),
            concat(["AWS/AppRunner", "5xxStatusResponses"], local.apprunner_dims),
          ]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title  = "Web — latency and instances"
          region = var.region
          stat   = "Average"
          period = 300
          metrics = [
            concat(["AWS/AppRunner", "RequestLatency"], local.apprunner_dims),
            concat(["AWS/AppRunner", "ActiveInstances"], local.apprunner_dims, [{ yAxis = "right" }]),
          ]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title  = "Worker — CPU and memory"
          region = var.region
          stat   = "Average"
          period = 300
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.worker.name],
            ["AWS/ECS", "MemoryUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.worker.name],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title  = "Jobs queue — depth, age, and dead letters"
          region = var.region
          stat   = "Maximum"
          period = 300
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.jobs.name],
            ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", aws_sqs_queue.jobs.name, { yAxis = "right" }],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.jobs_dlq.name, { label = "DLQ messages" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 12, width = 12, height = 6
        properties = {
          title  = "Funnel — processed vs failed (all stages)"
          region = var.region
          stat   = "Sum"
          period = 300
          metrics = [
            ["second-brain/funnel", "processed"],
            ["second-brain/funnel", "failed"],
            ["second-brain/funnel", "lag", { yAxis = "right", stat = "Average" }],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 12, width = 12, height = 6
        properties = {
          title  = "Triage — signal vs noise"
          region = var.region
          stat   = "Sum"
          period = 300
          metrics = [
            ["second-brain/funnel", "signal", "stage", "triage"],
            ["second-brain/funnel", "noise", "stage", "triage"],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 18, width = 12, height = 6
        properties = {
          title  = "Connectors — sync success and artifacts"
          region = var.region
          stat   = "Sum"
          period = 3600
          metrics = [
            ["second-brain/funnel", "sync_ok", "stage", "sync", "source", "slack"],
            ["second-brain/funnel", "sync_ok", "stage", "sync", "source", "gitlab"],
            ["second-brain/funnel", "sync_ok", "stage", "sync", "source", "jira"],
            ["second-brain/funnel", "sync_ok", "stage", "sync", "source", "gws"],
            ["second-brain/funnel", "sync_artifacts", "stage", "sync", "source", "slack", { yAxis = "right" }],
            ["second-brain/funnel", "sync_artifacts", "stage", "sync", "source", "gitlab", { yAxis = "right" }],
            ["second-brain/funnel", "sync_artifacts", "stage", "sync", "source", "jira", { yAxis = "right" }],
            ["second-brain/funnel", "sync_artifacts", "stage", "sync", "source", "gws", { yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 18, width = 12, height = 6
        properties = {
          title  = "Outbound executor — ok / failed / refused"
          region = var.region
          stat   = "Sum"
          period = 300
          metrics = [
            ["second-brain/funnel", "executor_ok", "stage", "executor"],
            ["second-brain/funnel", "executor_failed", "stage", "executor"],
            ["second-brain/funnel", "executor_refused", "stage", "executor"],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 24, width = 12, height = 6
        properties = {
          title  = "Rejections (human reject-only loop)"
          region = var.region
          stat   = "Sum"
          period = 3600
          metrics = [
            ["second-brain/funnel", "rejection", "stage", "reject"],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 24, width = 12, height = 6
        properties = {
          title  = "Database — CPU and connections"
          region = var.region
          stat   = "Average"
          period = 300
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.main.identifier],
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", aws_db_instance.main.identifier, { yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 30, width = 12, height = 6
        properties = {
          title  = "LLM — tokens (all agents)"
          region = var.region
          stat   = "Sum"
          period = 3600
          metrics = [
            ["second-brain/llm", "input_tokens"],
            ["second-brain/llm", "output_tokens"],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 30, width = 12, height = 6
        properties = {
          title   = "LLM — estimated spend (USD) and budget deferrals"
          region  = var.region
          period  = 3600
          yAxis   = { left = { label = "USD", showUnits = false }, right = { label = "deferrals" } }
          metrics = [
            [{ expression = "cost_micros/1000000", label = "spend USD (all agents)", id = "e1" }],
            ["second-brain/llm", "cost_micros", { id = "cost_micros", visible = false, stat = "Sum" }],
            ["second-brain/llm", "budget_deferred", { yAxis = "right", stat = "Sum" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 36, width = 24, height = 6
        properties = {
          title   = "LLM — estimated spend by agent (USD)"
          region  = var.region
          period  = 3600
          stacked = true
          yAxis   = { left = { label = "USD", showUnits = false } }
          metrics = [
            [{ expression = "triage/1000000", label = "triage", id = "e_triage" }],
            [{ expression = "extractor/1000000", label = "extractor", id = "e_extractor" }],
            [{ expression = "synthesizer/1000000", label = "synthesizer", id = "e_synthesizer" }],
            [{ expression = "linter/1000000", label = "linter", id = "e_linter" }],
            [{ expression = "reporter/1000000", label = "reporter", id = "e_reporter" }],
            [{ expression = "query/1000000", label = "query", id = "e_query" }],
            [{ expression = "workflow/1000000", label = "workflow", id = "e_workflow" }],
            ["second-brain/llm", "cost_micros", "agent", "triage", { id = "triage", visible = false, stat = "Sum" }],
            ["second-brain/llm", "cost_micros", "agent", "extractor", { id = "extractor", visible = false, stat = "Sum" }],
            ["second-brain/llm", "cost_micros", "agent", "synthesizer", { id = "synthesizer", visible = false, stat = "Sum" }],
            ["second-brain/llm", "cost_micros", "agent", "linter", { id = "linter", visible = false, stat = "Sum" }],
            ["second-brain/llm", "cost_micros", "agent", "reporter", { id = "reporter", visible = false, stat = "Sum" }],
            ["second-brain/llm", "cost_micros", "agent", "query", { id = "query", visible = false, stat = "Sum" }],
            ["second-brain/llm", "cost_micros", "agent", "workflow", { id = "workflow", visible = false, stat = "Sum" }],
          ]
        }
      },
    ]
  })
}
