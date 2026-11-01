## Ledger security

This product holds the company group's real accounts, invoices, tax files and staff
records, so this comes on top of the checklist above. Read
`docs/compliance-context.md` in the repository first, every run.

**Look at:**

- **Row-level security:** every table, view and storage bucket has the right policy, a
  new migration can't add a table without one, and the viewer role can't write. Check
  `SECURITY DEFINER` functions and views, which can bypass RLS.
- **Keys:** the Supabase secret key and database URLs never appear in a `VITE_*`
  variable or the built bundle, and only the scripts that need them use them.
- **Authentication:** Cloudflare Access in front, Entra sign-in, the password login
  switch, and whether a default seed password could exist in the cloud project.
- **Scripts pointed at production:** scripts read whichever `.env` is present. Check that
  a destructive script can't run against the cloud project by accident.
- **Ledger integrity:** the triggers that lock fiscal years and validated entries, what
  `reopen_fiscal_year` allows and records, and tombstones, status logs and document
  versions. A change to a closed period that leaves no trace is a severe finding.
- **Migrations:** does the applied schema match the repository? The migration journal
  has lagged behind the SQL files, so RLS and trigger changes may not be where they
  appear to be.
- **Sensitive fields:** passport numbers, birth dates, IBANs and tax IDs: who can read
  them, whether they appear in logs or exports, and whether they sit in tracked files.
- **Supply chain:** the `xlsx` tarball from a CDN, `ignore-scripts`, release-age rules,
  and browser-side PDF and spreadsheet parsers fed with untrusted files.
- **Backups and recovery:** can the accounts be restored after a mistake, and has that
  been tested?

**Never reproduce** an IBAN, passport number, tax ID or key in a finding: name the file
and line. You have no access to the cloud project; ask the human to check anything that
needs it.

