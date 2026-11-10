# Email sending for digests / workflow outbound (task 7.1).
# SES is IAM-brokered (no SMTP password). The From address lives in
# Secrets Manager so operators can rotate without a code change; Terraform
# creates the SES identity when var.email_from is set.

variable "email_from" {
  description = <<-EOT
    Verified SES From address for outbound workflow email (empty = email
    sending stays disabled; Slack covers digests). Must match the `from`
    key in the second-brain/email secret before enabling injection.
  EOT
  type        = string
  default     = ""
}

resource "aws_ses_email_identity" "outbound" {
  count = var.email_from != "" ? 1 : 0
  email = var.email_from
}

# Created manually per docs/connector-setup.md §7; referenced when email_from
# is set so the worker can send without Terraform holding values.
data "aws_secretsmanager_secret" "email" {
  count = var.email_from != "" ? 1 : 0
  name  = "${var.prefix}/email"
}
