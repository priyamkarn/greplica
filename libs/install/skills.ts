import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { packageRoot, skillNames } from "./paths.js";

export function copyBundledSkills(skillsRoot: string): string[] {
  const root = packageRoot();
  const installed: string[] = [];
  mkdirSync(skillsRoot, { recursive: true });

  for (const skillName of skillNames) {
    const source = join(root, "skills", skillName);
    if (!existsSync(join(source, "SKILL.md"))) throw new Error(`Bundled skill is missing: ${source}`);

    const destination = join(skillsRoot, skillName);
    const staged = `${destination}.tmp`;
    rmSync(staged, { recursive: true, force: true });
    cpSync(source, staged, { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    renameSync(staged, destination);
    installed.push(join(destination, "SKILL.md"));
  }

  return installed;
}
