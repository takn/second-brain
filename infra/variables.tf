variable "region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "prefix" {
  description = "Name prefix for all resources"
  type        = string
  default     = "second-brain"
}

variable "db_instance_class" {
  description = "RDS instance class — small to start, scale up later"
  type        = string
  default     = "db.t4g.small"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "db_backup_retention_days" {
  description = <<-EOT
    Automated RDS backup retention (days). Must be >= 1 to enable
    point-in-time recovery; spec requires a restorable point no older than 24h.
  EOT
  type        = number
  default     = 7
}

variable "db_backup_window" {
  description = "UTC preferred daily backup window (hh:mm-hh:mm)"
  type        = string
  default     = "06:00-07:00"
}

variable "raw_retention_days" {
  description = <<-EOT
    Expire raw S3 artifacts after this many days (0 = keep indefinitely).
    Noncurrent versions expire after min(30, retention) when retention > 0.
  EOT
  type        = number
  default     = 365
}

variable "web_cpu" {
  description = "App Runner vCPU for the web service"
  type        = string
  default     = "1 vCPU"
}

variable "web_memory" {
  type    = string
  default = "2 GB"
}

variable "worker_desired_count" {
  description = "Fargate worker task count"
  type        = number
  default     = 1
}

variable "google_workspace_domain" {
  description = "Google Workspace domain whose members pass the web SSO gate"
  type        = string
}

variable "l1_group_email" {
  description = "Google Group whose members get the L1 role (empty = role lookup disabled, everyone gets ROLE_DEFAULT)"
  type        = string
  default     = ""
}

variable "gitlab_root_group" {
  description = "Root GitLab group whose subgroups map to teams/projects (seeding and Jira path matching)"
  type        = string
  default     = ""
}

variable "web_default_role" {
  description = "Role for users matching no override or Google group (least-privilege L2; set to L1 only for single-operator dev)"
  type        = string
  default     = "L2"
}

variable "custom_domain" {
  description = "Custom domain for the web app (empty = App Runner default URL)"
  type        = string
  default     = ""
}

variable "github_repository" {
  description = "GitHub repository (owner/name) allowed to assume the CI deploy role via OIDC"
  type        = string
}

variable "slack_team_ids" {
  description = "Comma-separated Slack workspace IDs the connector ingests (empty = Slack ingestion idle)"
  type        = string
  default     = ""
}

variable "slack_channel_allowlist" {
  description = <<-EOT
    Comma-separated channel IDs to restrict Slack ingestion (empty = all
    public channels the bot can see). Cleared for org-wide public-channel
    ingestion (task 7.5); set temporarily for scoped testing.
  EOT
  type        = string
  default     = ""
}

variable "triage_threshold" {
  description = "P(signal) cutoff for the triage classifier — tune here, no code change (task 3.4)"
  type        = string
  default     = "0.5"
}

variable "digest_enabled" {
  description = "Master switch for the daily digest Slack DMs (task 5.9)"
  type        = string
  default     = "true"
}

variable "digest_allowlist" {
  description = <<-EOT
    Comma-separated emails allowed to receive the daily digest (empty = every
    project owner/follower). Kept to the operator until the org rollout
    announcement (task 7.5) — clearing this is the digest rollout switch.
  EOT
  type        = string
  default     = ""
}

variable "digest_hour_utc" {
  description = "UTC hour after which the daily digest sends (13 = ~9am ET)"
  type        = string
  default     = "13"
}

variable "budget_alert_email" {
  description = "Email for budget alarms (empty = no budget created)"
  type        = string
  default     = ""
}

variable "budget_monthly_usd" {
  description = "Monthly cost budget in USD"
  type        = number
  default     = 1000
}

variable "slack_backfill_days" {
  description = "Slack history horizon on first pull / after cursor wipe (days)"
  type        = string
  default     = "140"
}

variable "jira_sync_disabled" {
  description = "When true, GitLab→Jira counterpart writes are skipped (use during historical backfill)"
  type        = string
  default     = "false"
}
