resource "aws_sqs_queue" "jobs_dlq" {
  name                      = "${var.prefix}-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days to inspect parked jobs
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${var.prefix}-jobs"
  # Synth/extract Bedrock calls routinely take 3–6+ minutes (two attempts).
  # 120s caused receipt handles to expire mid-job → delete failures / redelivery.
  visibility_timeout_seconds = 900
  receive_wait_time_seconds  = 10

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq.arn
    maxReceiveCount     = 5
  })
}
