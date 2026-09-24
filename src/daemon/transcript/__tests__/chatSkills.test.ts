import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeSkills, codexSkills, skillMetadata } from '../chatSkills';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'wmux-skill-test-')); dirs.push(dir);
  const put = async (file: string, text: string) => { await mkdir(path.dirname(path.join(dir, file)), {recursive:true}); await writeFile(path.join(dir, file), text); };
  return { dir, put };
}
describe('scoped chat skill metadata', () => {
  it('reads folded frontmatter but never description-looking instructions', () => {
    expect(skillMetadata('description: body')).toEqual({});
    expect(skillMetadata('---\nname: "qa"\ndescription: >\n  first\n  second\n---\nsecret')).toMatchObject({name:'qa',description:'first second'});
  });
  it('honors personal precedence, hidden skills, local visibility and linked skills', async () => {
    const {dir,put} = await fixture();
    await put('account/skills/qa/SKILL.md','---\ndescription: personal\n---');
    await put('repo/.claude/skills/qa/SKILL.md','---\ndescription: project\n---');
    await put('repo/.claude/skills/hidden/SKILL.md','---\nuser-invocable: false\n---');
    await put('repo/.claude/skills/off/SKILL.md','---\ndescription: disabled\n---');
    await put('repo/.claude/settings.local.json',JSON.stringify({skillOverrides:{off:'off'}}));
    await put('shared/SKILL.md','---\nname: linked\ndescription: link\n---');
    await symlink(path.join(dir,'shared'),path.join(dir,'account/skills/linked'));
    const result = await claudeSkills(path.join(dir,'repo'),path.join(dir,'account'));
    expect(result.skills.map(s=>s.name).sort()).toEqual(['linked','qa']);
    expect(result.skills.find(s=>s.name==='qa')).toMatchObject({source:'user',description:'personal',invocation:'/qa'});
    expect(JSON.stringify(result)).not.toContain(dir);
  });
  it('only includes enabled plugins in the applicable project/account scope', async () => {
    const {dir,put} = await fixture();
    await put('account/plugins/cache/demo/skills/review/SKILL.md','---\ndescription: review\n---');
    await put('account/plugins/cache/demo/.claude-plugin/plugin.json','{"name":"demo"}');
    await put('account/plugins/installed_plugins.json',JSON.stringify({plugins:{'demo@official':[{scope:'user',installPath:path.join(dir,'account/plugins/cache/demo')}]}}));
    await put('account/settings.json',JSON.stringify({enabledPlugins:{'demo@official':true}}));
    expect((await claudeSkills(path.join(dir,'repo'),path.join(dir,'account'))).skills[0].invocation).toBe('/demo:review');
    await put('repo/.claude/settings.local.json',JSON.stringify({enabledPlugins:{'demo@official':false}}));
    expect((await claudeSkills(path.join(dir,'repo'),path.join(dir,'account'))).skills).toEqual([]);
  });
  it('bounds metadata, rejects control names and projects only enabled native Codex skills for the exact cwd', () => {
    const result = codexSkills({data:[{cwd:'/repo',skills:[
      {name:'qa',enabled:true,description:'x'.repeat(10000),path:'/secret',scope:'user'},
      {name:'hidden',enabled:false}, {name:'bad\nname',enabled:true}, {name:'qa',enabled:true},
    ],errors:[]}]},'/repo');
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({name:'qa',invocation:'$qa',source:'user'});
    expect(result.skills[0].description).toHaveLength(240);
    expect(JSON.stringify(result)).not.toContain('/secret');
    expect(codexSkills({data:[{cwd:'/other',skills:[]}]},'/repo').state).toBe('unavailable');
  });
});
