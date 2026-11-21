import fs from 'node:fs';
import path from 'node:path';
import { hasSkill } from '../extension-scan.mjs';

export const mountedSkills = skills => [...new Set(skills.filter(dir => typeof dir === 'string' && path.isAbsolute(dir) && hasSkill(dir)))];
export function skillPrompt(skills = []) {
  return mountedSkills(skills).map(dir => '\n\n## Skill (' + dir + ')\n\n' + fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).join('');
}
