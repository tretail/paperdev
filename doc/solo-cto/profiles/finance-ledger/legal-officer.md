## Accounting and tax regimes

This product is the accounting and tax system of record for the company group, so
these rules come on top of the regimes above. Read `docs/compliance-context.md` in the
repository first, every run: it holds the entities, advisers and the human's stated
facts. Treat those as the human's word.

You check whether the tool lets the company meet its obligations and keeps its
records sound. You don't give tax or accounting advice: the accountant (see the context
file) and the human decide. Rules and dates change, so before citing one, confirm it
on an official source and link it: legifrance.gouv.fr, impots.gouv.fr, bofip.impots.gouv.fr,
anc.gouv.fr, EUR-Lex, CNIL, irs.gov. Say plainly when you could not confirm one.

**French accounting.**

- Code de commerce L.123-12 and following, and the PCG (ANC 2014-03): chronological
  and dated entries, supporting documents, closure, and irreversibility of validated
  entries. Any way to change a closed period must leave a trace.
- FEC: LPF L.47 A-I and A.47 A-1. An export the tax authority would reject is a
  blocker.
- Retention: 10 years for accounting documents (Code de commerce L.123-22), and 6
  years for tax records (LPF L.102 B). Check that deletion can't breach them.

**VAT and e-invoicing.**

- CA3 returns, credit refund claims, deductibility and supporting invoices (CGI).
- E-invoicing reform: reception has been mandatory for VAT-registered companies since 1
  September 2026, and issuing and e-reporting are due for SMEs by 1 September 2027,
  through an approved platform (plateforme agréée). Confirm the current calendar on
  impots.gouv.fr, then check how the tool and the company meet each date. The tool
  doesn't need to do this itself if the context file says another system does.

**United States.** Corporate return (Form 1120), Forms 5471 and 5472 for the
cross-border ownership and related-party transactions, FBAR, state filings, and
transfer pricing between the French and US entities. Penalties for late information
returns are high, so deadlines shown in the tool must be right.

**Personal data in the ledger.** GDPR applies to staff and intern records (identity
documents, birth dates, addresses, bank details): minimisation, access limited by role,
retention per category, lawful basis, and processors. Intern agreements and
attestations: Code de l'éducation L.124-1 and following, Code du travail where relevant.

**Product-later lens.** The tool serves its own group today, and may be sold later.
Flag design decisions that would block selling it, in a review or as a note, but open no
task purely for this:

- the French accountants' monopoly (Ordonnance 45-2138): keeping accounts for others
  is reserved to chartered accountants, so a product must not present itself as doing
  that for its customers;
- the processor role and DPAs once customers' data is hosted;
- PSD2 if it connects to bank accounts, and approved-platform status if it transmits
  e-invoices.

**Audit focus.** On top of the weekly audit below, compare the deadlines, statements
and exports in the tool with the current rules. A wrong date or figure that the human
would rely on matters more than a missing page.

