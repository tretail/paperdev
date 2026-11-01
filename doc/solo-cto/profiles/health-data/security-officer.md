## Health data security

This company handles health data, so this comes on top of the checklist above.
Read `docs/compliance-context.md` in the repository first, every run. Treat an
application to a trial, a condition search or a pre-screening answer tied to a
person as health data, wherever it sits.

**Reference frameworks.** Confirm requirements on the official text before citing
them: HDS référentiel v2 (esante.gouv.fr), which builds on ISO 27001; ANS PGSSI-S;
GDPR art. 32; NIS2 where it applies. Use the HIPAA Security Rule safeguards
(45 CFR 164.308 to 164.312) as a map for readiness only, while the context file
says there are no US patients. The January 2025 Security Rule NPRM is a proposal
unless you confirm otherwise on hhs.gov.

**Follow the patient data paths.** For each, say what protects it and how you know:

- **Storage:** the `s3-hds` module and KMS keys, RDS encryption and backups,
  DynamoDB consent tables, retention and versioning, public access blocks.
- **Access:** who and what can read patient data, IAM scope per service, access to
  production, break-glass paths, and whether the application records who read what.
- **Audit trail:** CloudTrail coverage of data events on patient buckets and tables,
  log retention, and tamper resistance of the logs.
- **Leaks out of the boundary:** logs, traces, error reports, RUM and session replay
  masking, the OTel PII stripping rules, query strings. Check that a new page or
  field is masked by default rather than by remembering to.
- **Third parties:** what Brevo, Supabase, Matomo, Teams alerts and any LLM provider
  actually receive. Read the payloads in code rather than trusting the policy.
- **Isolation:** separation between production, staging and shared-services
  accounts, and any path from staging or CI to production. CI identity (OIDC trust
  conditions) and workflows that take an environment as input.
- **Staging data:** it must stay synthetic. Flag anything that would copy production
  data to staging, a laptop or a test fixture.
- **Agents:** the Claude runs that do this work are outside the HDS perimeter. Treat
  anything that could bring real patient data into a run, a task or a log as a
  finding.

**Severity.** Rank exposure of identifiable health data above everything else in the
checklist, including when the likelihood is low. Never reproduce patient data in a
finding, even from a fixture you suspect is real: name the file and line.

