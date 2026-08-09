import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Role definitions live as markdown (roles/*.md) for maintainability — prose
// and justified-skill tags edit better than escaped string literals. Each
// extension injects its role as an always-on system prompt via before_agent_start
// (not as a skill), so the role governs turn 1 without a progressive-disclosure
// read gate. See docs/handoff.md for the mechanism decision.
export function readRole(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "roles", `${name}.md`), "utf8");
}
