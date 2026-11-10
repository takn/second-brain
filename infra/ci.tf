# GitHub Actions -> AWS via OIDC federation: no long-lived AWS keys stored in
# GitHub. The deploy workflow exchanges its GitHub-issued ID token for
# temporary credentials scoped to exactly what a deploy needs.

data "tls_certificate" "github" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github.certificates[0].sha1_fingerprint]
}

data "aws_iam_policy_document" "ci_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Only workflows on main of this exact repository can assume the role.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/main"]
    }
  }
}

data "aws_iam_policy_document" "ci_deploy" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:PutImage",
      "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.web.arn, aws_ecr_repository.worker.arn]
  }

  statement {
    sid = "DeployWorker"
    actions = [
      "ecs:RunTask", "ecs:DescribeTasks", "ecs:DescribeServices",
      "ecs:UpdateService", "ecs:DescribeTaskDefinition",
    ]
    resources = ["*"] # run-task/describe need task + task-def ARNs with changing revisions
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid       = "PassWorkerRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.worker_task.arn, aws_iam_role.worker_execution.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid       = "DeployWeb"
    actions   = ["apprunner:ListServices"]
    resources = ["*"]
  }

  statement {
    sid = "StartWebDeployment"
    # ListOperations: CI polls the deployment to a terminal state and fails
    # the job on rollback (App Runner rolls back silently otherwise).
    actions   = ["apprunner:StartDeployment", "apprunner:DescribeService", "apprunner:ListOperations"]
    resources = [aws_apprunner_service.web.arn]
  }
}

resource "aws_iam_role" "ci_deploy" {
  name               = "${var.prefix}-ci-deploy"
  assume_role_policy = data.aws_iam_policy_document.ci_trust.json
}

resource "aws_iam_role_policy" "ci_deploy" {
  name   = "deploy"
  role   = aws_iam_role.ci_deploy.id
  policy = data.aws_iam_policy_document.ci_deploy.json
}
