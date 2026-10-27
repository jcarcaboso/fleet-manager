import { describe, expect, it } from 'vitest';
import {
  addCounts, attemptVerb, clientName, clientShort, countTotal, emptyCounts, failPath, hasDetail, stateParts, stepLabel, targetClient, targetIcon, targetKind,
  targetLabel, targetShort, targetWhere, tstate,
} from '@/lib/targets';

describe('Targets', () => {
  it('derives the kind and client from the name', () => {
    expect(targetKind('skills')).toBe('skills');
    expect(targetKind('ai-client/claude')).toBe('ai-client');
    expect(targetClient({ name: 'ai-client/claude' })).toBe('claude');
    expect(targetClient({ name: 'agent-file/codex' })).toBe('codex');
    expect(targetClient({ name: 'agent-file/x.md' })).toBeNull();
    expect(targetClient({ name: 'skills', aiClient: { client: 'opencode' } })).toBe('opencode');
  });
  it('names clients', () => {
    expect(clientName('claude')).toBe('Claude Code');
    expect(clientShort('claude')).toBe('Claude');
    expect(clientName('gemini')).toBe('Gemini');
    expect(clientName(null)).toBe('AI client');
  });
  it('labels Targets', () => {
    expect(targetLabel({ name: 'skills' })).toBe('Skills');
    expect(targetLabel({ name: 'ai-client/claude' })).toBe('Claude Code connection');
    expect(targetLabel({ name: 'agent-file/claude', file: { name: 'CLAUDE.md', bundleDigest: null } })).toBe('CLAUDE.md for Claude Code');
    expect(targetLabel({ name: 'agent-file/claude' })).toBe('Claude Code agent file');
    expect(targetLabel({ name: 'weird/thing' })).toBe('weird/thing');
    expect(targetShort({ name: 'ai-client/codex' })).toBe('Codex');
    expect(targetShort({ name: 'agent-file/codex' })).toBe('Codex file');
    expect(targetShort({ name: 'skills' })).toBe('Skills');
    expect(targetIcon({ name: 'ai-client/codex' })).toBe('spark');
    expect(targetIcon({ name: 'agent-file/codex' })).toBe('file');
    expect(targetIcon({ name: 'skills' })).toBe('layers');
    expect(targetIcon({ name: 'unknown/x' })).toBe('file');
  });
  it('shows where a Target lives', () => {
    expect(targetWhere({ base: 'home', path: '.claude' })).toBe('~/.claude');
    expect(targetWhere({ base: 'workspace', path: 'x' })).toBe('workspace:x');
    expect(targetWhere({ name: 'skills' })).toBe('');
  });
  it('joins a failing path to the Target base', () => {
    expect(failPath({ base: 'home', path: '.claude' }, '.claude/settings.json')).toBe('~/.claude/settings.json');
    expect(failPath({ base: 'ws', path: 'x' }, 'a/b')).toBe('ws:a/b');
    expect(failPath(null, 'a/b')).toBe('a/b');
    expect(failPath({ base: 'home', path: null }, 'a/b')).toBe('a/b');
    expect(failPath({ base: 'home', path: 'x' }, '')).toBe('');
    expect(failPath({ base: 'home', path: 'x' }, null)).toBe('');
  });
  it('labels attempt steps and detail', () => {
    expect(stepLabel('lock')).toBe('Taking the lock');
    expect(stepLabel('receipt')).toBe('Writing the receipt');
    expect(stepLabel('future_step')).toBe('Future step');
    expect(stepLabel('constructor')).toBe('Constructor');
    expect(hasDetail({ diagnostic: null, path: null, step: null })).toBe(false);
    expect(hasDetail({ step: 'lock' })).toBe(true);
    expect(hasDetail(null)).toBe(false);
  });
});

describe('states', () => {
  it('maps API states to a level, icon and label', () => {
    expect(tstate('succeeded')).toEqual({ level: 'good', kind: 'check', label: 'In sync' });
    expect(tstate('failed').label).toBe('Failed');
    expect(tstate('pending').label).toBe('Waiting');
    expect(tstate('brand_new')).toEqual({ level: 'neutral', kind: 'minus', label: 'Brand new' });
    expect(tstate(null).label).toBe('Unknown');
    expect(tstate('toString').label).toBe('ToString');
    expect(attemptVerb('applying')).toBe('is applying');
    expect(attemptVerb('odd')).toBe('odd');
  });
  it('counts', () => {
    const a = emptyCounts();
    expect(addCounts(a, { failed: 2, succeeded: 3 })).toBe(a);
    expect(addCounts(a, { failed: 1, pending: '2' as unknown as number })).toEqual({ pending: 2, applying: 0, succeeded: 3, failed: 3, superseded: 0 });
    expect(countTotal(a)).toBe(8);
    expect(countTotal(null)).toBe(0);
  });
  it('builds legend parts', () => {
    const parts = stateParts({ succeeded: 1, failed: 4 });
    expect(parts.map(p => p.key)).toEqual(['succeeded', 'applying', 'pending', 'failed', 'superseded']);
    expect(parts.find(p => p.key === 'succeeded')).toMatchObject({ value: 1, unit: 'assignment' });
    expect(parts.find(p => p.key === 'failed')).toMatchObject({ value: 4, unit: 'assignments', level: 'critical' });
    expect(stateParts({ failed: 2 }, 'Targets').every(p => p.unit === 'Targets')).toBe(true);
  });
});
