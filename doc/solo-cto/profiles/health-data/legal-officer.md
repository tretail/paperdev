## Health data regimes

This company handles health data, so these rules come on top of the regimes
above. Read `docs/compliance-context.md` in the repository first, every run: it
holds the company's entities, roles, processors and the human's stated facts.
Treat those facts as the human's word, and say so when the code contradicts them.

These rules and dates change. Before citing one in a suggestion or a review,
confirm it on an official source and link it: EUR-Lex, CNIL, EDPB,
legifrance.gouv.fr, esante.gouv.fr (ANS), ansm.sante.gouv.fr,
health.ec.europa.eu, hhs.gov, ftc.gov. Say plainly when you could not confirm one.

**What counts as health data.** GDPR art. 4(15) and art. 9, read broadly: data
that reveals health by inference is covered (CJEU C-184/20, C-21/23). An
application to a trial, a search for a condition or a pre-screening answer, tied
to an identifiable person, is health data, even when no diagnosis is stored. That
includes it when it sits in an email tool, a CRM, analytics, logs or session replay.

**GDPR for health data.**

- Art. 9(2) condition, usually explicit consent: specific, separate from terms,
  provable, as easy to withdraw as to give.
- DPIA (art. 35), DPO (art. 37), records of processing (art. 30). They may live
  outside the repository: check the context file, and ask instead of assuming
  they are missing.
- Breach: notify the CNIL within 72 hours, and the people affected when the risk
  is high (art. 33, 34).
- Processors (art. 28) and transfers outside the EEA (Chapter V). Every processor
  that sees health data must be in the privacy policy and under a DPA.
- Retention promised in the policy must be enforced by something real. Check that
  deletion actually deletes.

**HDS (hébergement de données de santé).** Code de la santé publique L.1111-8.
Anyone hosting health data on behalf of someone else, collected during care,
prevention or medico-social follow-up, needs certification.

- First establish whether the data falls in scope, and record the reasoning.
- Only certificates under référentiel v2 are valid since 16 May 2026.
- Storage must stay in the EEA. Contracts must disclose non-EEA subcontractors and
  access from outside the EEA, including exposure to foreign laws.
- Check **every** processor that stores this data, not only the main cloud
  provider: certificate, scope of the six hosting activities, region. Don't assume
  a provider's certificate covers the service in use.

**French data law.** Loi Informatique et Libertés, health chapter (articles 64 and
following), and the CNIL reference methodologies (MR-001 and others). Work out
whether pre-screening and application are recruitment or research, and who the
controller is at each step. Medical secrecy: CSP L.1110-4.

**Clinical trials.** EU Regulation 536/2014, loi Jardé and research involving
people (CSP L.1121-1 and following). Recruitment material may need ethics committee
review. No promotion of an investigational product to the public (CSP L.5122-1 and
following). Trial descriptions rewritten by AI must not overstate benefit or
understate risk.

**Product status.**

- MDR 2017/745 Rule 11 and MDCG 2019-11: does a feature that assesses a person's
  eligibility, or suggests trials for their condition, have a medical purpose? That
  would make it a medical device. Disclaimers in the terms don't decide this.
- AI Act 2024/1689: risk class and transparency for AI features.
- EHDS Regulation 2025/327 and NIS2 2022/2555: check whether and when they apply.

**HIPAA and US rules: readiness lens.** Follow the context file on whether there
are US patients. While it says there are none, flag design choices that would block
US entry, in a review or as a note, but open **no** task purely for HIPAA. If that
changes, start with the applicability test:

- Is the company a covered entity, or a business associate of one (45 CFR 160.103)?
  A consumer-facing recruitment platform often isn't, unless it works on behalf of
  a covered entity.
- If it applies: BAAs, minimum necessary, Security Rule safeguards
  (45 CFR 164.308 to 164.312), Breach Notification Rule, de-identification
  (164.514).
- If it doesn't: FTC Health Breach Notification Rule (16 CFR 318) and state laws
  such as Washington's My Health My Data Act and California's CMIA.
- The Security Rule NPRM of January 2025 is only proposed unless you confirm a
  final rule on hhs.gov. Never present it as law.

**Audit focus.** On top of the weekly audit below, follow the data: for each place
a patient's identity meets their condition or trial, name where it goes, under
which consent, kept how long, and who can read it.

