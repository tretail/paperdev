#!/usr/bin/env node
// Writes the generic solo-CTO agent instructions plus a profile's fragments to a
// company's agents. See doc/SOLO-CTO-WORKFLOW.md, "Company profiles".
//
//   node doc/solo-cto/profiles/apply.mjs --company Patlynk --profile health-data [--dry-run]
//
// A fragment named after an agent slug goes before that agent's "## Weekly" audit
// heading if it has a legal or security audit, otherwise at the end. all-agents.md
// goes last on every agent. Re-run after changing the generic instructions.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentsDir = path.join(here, "..", "company", "agents");
const INSERT_BEFORE = {
  "legal-officer": "## Weekly legal audit",
  "security-officer": "## Weekly security audit",
};

const { values } = parseArgs({
  options: {
    company: { type: "string" },
    profile: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "api-base": { type: "string", default: "http://localhost:3100" },
  },
});
if (!values.company || !values.profile) {
  throw new Error("--company and --profile are required");
}
const profileDir = path.join(here, values.profile);
if (!existsSync(profileDir)) throw new Error(`No profile at ${profileDir}`);

async function api(pathname, init) {
  const res = await fetch(`${values["api-base"]}/api${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${pathname}: ${res.status} ${await res.text()}`);
  return res.json();
}

function genericBody(slug) {
  const raw = readFileSync(path.join(agentsDir, slug, "AGENTS.md"), "utf8");
  const match = raw.match(/^---\n[\s\S]*?\n---\n+/);
  if (!match) throw new Error(`${slug}: AGENTS.md has no frontmatter`);
  return raw.slice(match[0].length);
}

function readFragment(name) {
  const file = path.join(profileDir, `${name}.md`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function assemble(slug) {
  let body = genericBody(slug);
  const fragment = readFragment(slug);
  if (fragment) {
    const heading = INSERT_BEFORE[slug];
    if (heading) {
      const at = body.indexOf(`\n${heading}\n`);
      if (at < 0) throw new Error(`${slug}: heading "${heading}" not found`);
      body = body.slice(0, at + 1) + fragment + body.slice(at + 1);
    } else {
      body += fragment;
    }
  }
  return body + (readFragment("all-agents") ?? "");
}

const slugs = readdirSync(agentsDir);
for (const file of readdirSync(profileDir)) {
  const slug = file.replace(/\.md$/, "");
  if (slug !== "all-agents" && !slugs.includes(slug)) throw new Error(`Fragment ${file} matches no agent`);
}

const companies = await api("/companies");
const company = companies.find((c) => c.name === values.company);
if (!company) throw new Error(`No company named ${values.company}`);
const agents = await api(`/companies/${company.id}/agents`);

for (const slug of slugs) {
  const agent = agents.find((a) => a.urlKey === slug);
  if (!agent) throw new Error(`${values.company} has no agent ${slug}`);
  const content = assemble(slug);
  const current = await api(`/agents/${agent.id}/instructions-bundle/file?path=AGENTS.md`);
  const state = current.content === content ? "unchanged" : "changed";
  console.log(`${slug}: ${state} (${current.content.length} -> ${content.length} chars)`);
  if (values["dry-run"] || state === "unchanged") continue;
  await api(`/agents/${agent.id}/instructions-bundle/file`, {
    method: "PUT",
    body: JSON.stringify({ path: "AGENTS.md", content, baseHash: current.contentHash }),
  });
}
