# second-brain infrastructure

Terraform for the dedicated AWS account. Everything the app needs, flat and readable:

| File | Resources |
|---|---|
| `network.tf` | VPC, subnets, security groups, App Runner VPC connector |
| `db.tf` | RDS PostgreSQL 18, credentials in Secrets Manager, automated backups + PITR |
| `storage.tf` | Versioned S3 raw-artifact bucket + configurable lifecycle retention |
| `email.tf` | Optional SES From identity for workflow outbound email |
| `queue.tf` | SQS jobs queue + dead-letter queue |
| `ecr.tf` | Container registries for web and worker |
| `iam.tf` | Shared app policy, App Runner and Fargate roles |
| `ci.tf` | GitHub OIDC provider + least-privilege CI deploy role |
| `budget.tf` | Monthly cost budget alarm (optional, needs `budget_alert_email`) |
| `observability.tf` | CloudWatch dashboard + ops alarms |
| `services.tf` | App Runner (web), ECS Fargate (worker), CloudWatch logs |

## Bootstrap (once, when the account arrives)

1. **State bucket** — create manually (chicken-and-egg with remote state):

   ```bash
   aws s3 mb s3://second-brain-tfstate-<ACCOUNT_ID> --region <REGION>
   aws s3api put-bucket-versioning --bucket second-brain-tfstate-<ACCOUNT_ID> \
     --versioning-configuration Status=Enabled
   ```

2. Uncomment the `backend "s3"` block in `versions.tf` and fill in the bucket name.

3. **First apply** — images don't exist yet, so bring up everything except the services:

   ```bash
   terraform init
   terraform apply -target=aws_ecr_repository.web -target=aws_ecr_repository.worker
   # build + push both images to the ECR URLs from the outputs, then:
   terraform apply
   ```

4. **GitHub repository variables** — set under Settings → Secrets and variables → Actions to activate the deploy workflow:
   `AWS_ACCOUNT_ID`, `AWS_REGION`, and `AWS_ROLE_ARN` (from
   `terraform output ci_role_arn`). CI authenticates via OIDC — no AWS keys in GitHub.

## Access model

Humans sign in through IAM Identity Center (no IAM users / long-lived keys):

- **Admin** (`AdministratorAccess`) — account owner; runs Terraform applies
- **Developer** (`PowerUserAccess`) — future teammates; everything except IAM management
- **Viewer** (`ReadOnlyAccess`) — logs, dashboards, costs

Automation:

- **`second-brain-ci-deploy`** (`ci.tf`) — GitHub workflows on `main` only, via OIDC:
  ECR push, migration run-task + service rollout, App Runner deployment
- **Runtime roles** (`iam.tf`) — web/worker access scoped to the raw bucket, job
  queues, and `second-brain/*` secrets

Anticipated later grants (add to the app policy when the workstream lands):
EventBridge Scheduler (connector polls), ECS Exec (worker debugging),
Route 53/ACM (custom domain). SES send is wired in `email.tf` / `iam.tf`
when `email_from` is set (task 7.1).

## Backup and retention (task 7.3)

| Resource | Default | Tunable |
|---|---|---|
| RDS automated backups + PITR | 7-day retention, daily window `06:00–07:00` UTC | `db_backup_retention_days`, `db_backup_window` |
| S3 raw artifacts | Expire after 365 days; noncurrent versions after 30 days; abort incomplete multipart after 7 days | `raw_retention_days` (`0` = keep forever) |

RDS point-in-time restore uses the continuous backup stream (latest restorable
time is typically within minutes). Final snapshot on delete is kept
(`skip_final_snapshot = false`).

## Costs (rough, us-east-1)

App Runner 1 vCPU/2 GB (~$50/mo at full utilization, scales to ~$5 idle), Fargate 0.5 vCPU
worker (~$18/mo), RDS db.t4g.small (~$25/mo), NAT gateway (~$35/mo — required because App
Runner VPC egress routes all web outbound through the private subnets), plus S3/SQS/logs at
low usage — roughly **$130/mo** to start.
