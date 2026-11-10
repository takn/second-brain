# Copy to <yourorg>.auto.tfvars (auto-loaded) or pass with -var-file.
# Required:
google_workspace_domain = "example.org"                 # Workspace domain gating web SSO
github_repository       = "yourname/second-brain"         # GitHub repo for CI OIDC deploys

# Optional (defaults shown):
# l1_group_email     = ""   # Google Group granting the L1 role; empty = everyone gets ROLE_DEFAULT
# gitlab_root_group  = ""   # root GitLab group for team/project seeding and Jira path matching
# slack_team_ids     = ""   # comma-separated Slack workspace IDs to ingest
# digest_allowlist   = ""   # comma-separated emails; empty = all owners/followers
# budget_alert_email = ""   # empty = no budget alarm
# email_from         = ""   # verified SES sender; empty = email sending disabled
