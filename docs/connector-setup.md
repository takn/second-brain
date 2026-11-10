# Connector setup

What a human with org admin rights must do to give the brain its connector
credentials. Everything else — endpoints, polling, webhook handlers,
Terraform — is code.

Every credential goes into AWS Secrets Manager in your deployment account
under the exact names below (`<prefix>` defaults to `second-brain`). Never put
credentials in commits, chat, or CI variables.

## Slack — `<prefix>/slack`

1. Create a Slack app in your workspace with the bot scopes:
   `channels:history`, `channels:read`, `users:read`, `users:read.email`,
   `chat:write`, `im:write`.
2. Install it to the workspace and copy the **Bot User OAuth Token** (`xoxb-…`).
3. Store it:

```bash
aws secretsmanager create-secret --name <prefix>/slack \
  --secret-string '{"bot_token":"xoxb-REPLACE"}'
```

4. Set `slack_team_ids` in your tfvars to the workspace ID(s) to ingest.

## GitLab — `<prefix>/gitlab`

Needs Owner on your root group (`gitlab_root_group` in tfvars).

1. Create a group access token: role **Reporter**, scope **`api`**
   (`read_api` alone blocks one-click issue creation).
2. Generate a webhook secret: `openssl rand -hex 32`
3. Store both:

```bash
aws secretsmanager create-secret --name <prefix>/gitlab \
  --secret-string '{"token":"glpat-REPLACE","webhook_secret":"HEX-REPLACE"}'
```

4. Configure a group webhook pointing at
   `https://<your-web-url>/api/webhooks/gitlab` with that secret token and
   trigger events: Issues, Merge requests, Pipelines, Subgroup events.

## Google Workspace — `<prefix>/gws`

1. Create a GCP service account with domain-wide delegation; grant it these
   read-only scopes in Admin console → API controls: Drive, Calendar, Meet,
   Directory (users + groups readonly).
2. Pick an impersonation subject (a real Workspace user; a dedicated
   service user is cleanest) with access to the watched transcripts folder.
3. Store the key:

```bash
aws secretsmanager create-secret --name <prefix>/gws \
  --secret-string '{"service_account_key":{...},"subject":"user@example.org","watched_folder_id":"DRIVE-FOLDER-ID"}'
```

4. Set `google_workspace_domain` in tfvars; optionally `l1_group_email` for
   role mapping.

## Jira (transition source) — `<prefix>/jira`

```bash
aws secretsmanager create-secret --name <prefix>/jira \
  --secret-string '{"email":"bot@example.org","api_token":"REPLACE","cloud_id":"REPLACE"}'
```

Path-prefix → Jira-project mappings live in the worker's Jira config file
(see `worker/src/connectors/jira.ts`, `JiraConfig`).

## Google OAuth (web SSO) — `<prefix>/google-oauth`

1. Create an OAuth client (web) in GCP; authorized redirect:
   `https://<your-web-url>/oauth2/callback`.
2. Store it:

```bash
aws secretsmanager create-secret --name <prefix>/google-oauth \
  --secret-string '{"client_id":"REPLACE","client_secret":"REPLACE","cookie_secret":"'$(openssl rand -base64 32 | tr -- '+/' '-_')'"}'
```

## Email (optional) — `<prefix>/email`

Set `email_from` in tfvars to a verified SES sender and store:

```bash
aws secretsmanager create-secret --name <prefix>/email \
  --secret-string '{"from":"brain@example.org"}'
```
