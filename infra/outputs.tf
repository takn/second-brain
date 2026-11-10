output "web_url" {
  value = "https://${aws_apprunner_service.web.service_url}"
}

output "ecr_web" {
  value = aws_ecr_repository.web.repository_url
}

output "ecr_worker" {
  value = aws_ecr_repository.worker.repository_url
}

output "raw_bucket" {
  value = aws_s3_bucket.raw.bucket
}

output "jobs_queue_url" {
  value = aws_sqs_queue.jobs.url
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "ci_role_arn" {
  description = "Set as AWS_ROLE_ARN in GitLab CI/CD variables"
  value       = aws_iam_role.ci_deploy.arn
}

output "db_backup_retention_days" {
  description = "Automated backup + PITR retention window"
  value       = aws_db_instance.main.backup_retention_period
}

output "raw_retention_days" {
  description = "S3 raw artifact expiry (0 = indefinite)"
  value       = var.raw_retention_days
}
