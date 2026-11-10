# Security

Do not report security vulnerabilities through public issues.

Use GitHub's private vulnerability reporting ("Report a vulnerability" under
the repository's Security tab) with a description of the issue, steps to
reproduce, and impact assessment. You should receive a response within five
business days.

Scope notes for deployers:

- Connector credentials live exclusively in AWS Secrets Manager; agents never
  see raw credentials (the executor service brokers outbound actions).
- The web app sits behind an OAuth2 proxy restricted to your Workspace
  domain; role assignment is driven by Google Group membership.
- Raw ingested artifacts preserve source permissions metadata, but the brain
  itself is org-visible by design — do not point connectors at sources whose
  content must not be org-readable.
