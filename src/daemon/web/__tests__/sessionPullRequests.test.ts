import { describe, expect, it } from 'vitest';
import { githubRepository, sessionPullRequests } from '../sessionPullRequests';
import type { GitRunner } from '../sessionDiff';
const git: GitRunner = async args => ({ok:true,stdout:args.includes('remote') ? 'git@github.com:team/project.git\n' : 'feature/test\n',stderr:''});
describe('phone PR status', () => {
  it('only accepts credential-free GitHub remotes', () => {
    expect(githubRepository('https://github.com/team/project.git')).toBe('team/project');
    expect(githubRepository('git@github.com:team/project.git')).toBe('team/project');
    for (const url of ['https://github.com.evil.invalid/team/repo', 'https://secret@github.com/team/repo', 'https://evil.invalid/repo', 'file:///tmp/repo']) {
      expect(githubRepository(url)).toBeNull();
    }
  });
  it('passes a fixed repo and branch and validates response links', async () => {
    expect(await sessionPullRequests('/repo', git, async (repo, branch) => {
      expect(repo).toBe('team/project'); expect(branch).toBe('feature/test');
      return [{number:7,title:'Review',state:'OPEN',url:'https://github.com/team/project/pull/7',isDraft:true,headRefName:'feature/test',headRepository:{nameWithOwner:'team/project'}}];
    })).toMatchObject({state:'available',items:[{number:7,isDraft:true}]});
    expect(await sessionPullRequests('/repo', git, async () => [{number:7,title:'Review',state:'OPEN',url:'https://evil.invalid',isDraft:false}]))
      .toEqual({state:'unavailable',items:[]});
  });
  it('excludes same-name branches in another fork and deleted head repositories', async () => {
    const row = {number:7,title:'Review',state:'OPEN',url:'https://github.com/team/project/pull/7',isDraft:false,headRefName:'feature/test'};
    expect(await sessionPullRequests('/repo', git, async () => [
      {...row,headRepository:{nameWithOwner:'someone/project'}},
      {...row,headRepository:null},
      {...row,headRefName:'other',headRepository:{nameWithOwner:'team/project'}},
      {...row,headRepository:{nameWithOwner:'TEAM/Project'}},
    ])).toEqual({state:'available',items:[{number:7,title:'Review',state:'OPEN',url:row.url,isDraft:false}]});
  });
  it('refuses missing head identity instead of trusting the branch filter', async () => {
    expect(await sessionPullRequests('/repo', git, async () => [
      {number:7,title:'Review',state:'OPEN',url:'https://github.com/team/project/pull/7',isDraft:false},
    ])).toEqual({state:'unavailable',items:[]});
  });
  it('does not claim no PR after a full page of unrelated forks', async () => {
    expect(await sessionPullRequests('/repo', git, async () => Array.from({length:100}, (_, i) => ({
      number:i+1,title:'Review',state:'OPEN',url:`https://github.com/team/project/pull/${i+1}`,isDraft:false,
      headRefName:'feature/test',headRepository:{nameWithOwner:'someone/project'},
    })))).toEqual({state:'unavailable',items:[]});
  });
  it('distinguishes no PR from missing CLI or authentication', async () => {
    expect(await sessionPullRequests('/repo', git, async () => [])).toEqual({state:'available',items:[]});
    expect(await sessionPullRequests('/repo', git, async () => { throw new Error('not signed in'); })).toEqual({state:'unavailable',items:[]});
  });
});
