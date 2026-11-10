data "aws_caller_identity" "current" {}

# Immutable raw artifact store.
resource "aws_s3_bucket" "raw" {
  bucket = "${var.prefix}-raw-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_versioning" "raw" {
  bucket = aws_s3_bucket.raw.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "raw" {
  bucket                  = aws_s3_bucket.raw.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Configurable retention (deployment spec / task 7.3). Default 365 days;
# set raw_retention_days = 0 to keep forever. Incomplete multipart uploads
# are always cleaned up after 7 days.
resource "aws_s3_bucket_lifecycle_configuration" "raw" {
  bucket = aws_s3_bucket.raw.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  dynamic "rule" {
    for_each = var.raw_retention_days > 0 ? [1] : []
    content {
      id     = "expire-raw-artifacts"
      status = "Enabled"

      filter {}

      expiration {
        days = var.raw_retention_days
      }

      noncurrent_version_expiration {
        noncurrent_days = min(30, var.raw_retention_days)
      }
    }
  }
}
