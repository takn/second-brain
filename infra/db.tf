resource "aws_db_subnet_group" "main" {
  name       = "${var.prefix}-db"
  subnet_ids = aws_subnet.private[*].id
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_instance" "main" {
  identifier     = "${var.prefix}-db"
  engine         = "postgres"
  engine_version = "18"

  instance_class    = var.db_instance_class
  allocated_storage = var.db_allocated_storage_gb
  storage_type      = "gp3"

  db_name  = "brain"
  username = "brain"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false

  # Automated backups + PITR (deployment spec: restorable point ≤ 24h old).
  # Retention >= 1 enables continuous PITR up to LatestRestorableTime.
  backup_retention_period = max(var.db_backup_retention_days, 1)
  backup_window           = var.db_backup_window
  copy_tags_to_snapshot   = true
  deletion_protection     = true
  skip_final_snapshot     = false
  final_snapshot_identifier = "${var.prefix}-db-final"
}

resource "aws_secretsmanager_secret" "database_url" {
  name = "${var.prefix}/database-url"
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  # sslmode=require: RDS enforces SSL by default (rds.force_ssl) on Postgres 15+.
  secret_string = "postgres://brain:${random_password.db.result}@${aws_db_instance.main.address}:5432/brain?sslmode=require"
}
