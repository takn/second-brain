# SHA-tagged images are immutable; only the `latest` pointer may move.
resource "aws_ecr_repository" "web" {
  name                 = "${var.prefix}/web"
  image_tag_mutability = "IMMUTABLE_WITH_EXCLUSION"
  force_delete         = false

  image_tag_mutability_exclusion_filter {
    filter      = "latest"
    filter_type = "WILDCARD"
  }
}

resource "aws_ecr_repository" "worker" {
  name                 = "${var.prefix}/worker"
  image_tag_mutability = "IMMUTABLE_WITH_EXCLUSION"
  force_delete         = false

  image_tag_mutability_exclusion_filter {
    filter      = "latest"
    filter_type = "WILDCARD"
  }
}

resource "aws_ecr_lifecycle_policy" "keep_recent" {
  for_each   = { web = aws_ecr_repository.web.name, worker = aws_ecr_repository.worker.name }
  repository = each.value

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 20 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}
