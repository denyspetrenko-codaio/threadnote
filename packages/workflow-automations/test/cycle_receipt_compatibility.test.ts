import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {decodeNativeCyclePlan, initializeNativeCycle, nativeCyclePhaseHash} from '../src/cycle.js';
import {
  nativeCycleBaseRequalificationReceiptDigest,
  nativeCycleRebaseReceiptDigest,
  type NativeCycleReview,
  type NativeCycleSnapshot,
} from '../src/cycle_review.js';
import {decodeNativeCycleRuntime, type NativeCycleRuntime} from '../src/cycle_runtime.js';

const object = (value: string) => EffectString.repeat(40)(value);
const digest = EffectString.repeat(64)('a');
const plan = (baseBranch: string) =>
  decodeNativeCyclePlan({
    format: 'threadnote-native-cycle-plan',
    version: 1,
    featureId: 'feature',
    project: 'repo',
    objective: 'Preserve reviewed history across approved base changes.',
    delivery: 'local',
    source: {
      root: {uri: 'threadnote://user/me/plan', memoryId: 'tn_123', revision: digest},
      binding: {bindingId: digest, runId: 'run', generation: 'gen', profile: 'desktop'},
      documentHash: digest,
    },
    completion: {},
    phases: [
      {
        id: 'one',
        definitionHash: digest,
        title: 'One',
        dependsOn: [],
        allowedPaths: ['src/'],
        acceptanceCriteria: ['works'],
        safeToMergeReason: 'Bounded source change.',
        branch: 'feature/one',
        baseBranch,
        status: 'pending',
        acceptanceRefs: [{id: 'a1', criterion: 'works', requirements: ['req'], specScenarios: []}],
      },
    ],
  });
const report = (snapshot: NativeCycleSnapshot): NativeCycleReview => ({
  snapshotId: snapshot.snapshotId,
  phaseHash: snapshot.phaseHash,
  snapshotTree: snapshot.tree,
  status: 'complete',
  mode: 'full',
  selected: ['correctness', 'simplicity'],
  lanes: [
    {name: 'correctness', status: 'complete'},
    {name: 'simplicity', status: 'complete'},
  ],
  findings: [],
});
const runtime = (reason: string, authority: string): NativeCycleRuntime => {
  const oldPlan = plan('prerelease');
  const currentPlan = plan('main');
  const initialSource: NativeCycleSnapshot = {
    format: 'threadnote-native-cycle-snapshot',
    version: 1,
    snapshotId: 'initial',
    phaseId: 'one',
    phaseHash: nativeCyclePhaseHash(oldPlan, 'one'),
    repo: 'repo',
    head: object('b'),
    baseTree: object('2'),
    scopeBase: object('e'),
    declaredBaseHead: object('c'),
    scopeFiles: ['src/change.ts'],
    tree: object('d'),
    acceptedHead: object('b'),
    files: ['src/change.ts'],
    pinnedRef: 'refs/threadnote/cycles/snapshot/' + digest,
  };
  const rebase = {
    preRebaseHead: object('a'),
    ontoHead: object('c'),
    rebasedHead: object('b'),
    reason,
    authority,
    beforeRef: 'refs/threadnote/cycles/rebase-before/' + digest,
    afterRef: 'refs/threadnote/cycles/rebase-after/' + digest,
  };
  const initial: NativeCycleSnapshot = {
    ...initialSource,
    rebase: {...rebase, receiptDigest: nativeCycleRebaseReceiptDigest(initialSource, rebase)},
  };
  const nextSource: NativeCycleSnapshot = {
    ...initialSource,
    snapshotId: 'qualified',
    phaseHash: nativeCyclePhaseHash(currentPlan, 'one'),
    head: object('f'),
    acceptedHead: object('f'),
    declaredBaseHead: object('1'),
    tree: object('3'),
    previous: initial.snapshotId,
    previousTree: initial.tree,
  };
  const qualification = {
    preRebaseHead: initial.head,
    ontoHead: nextSource.declaredBaseHead,
    rebasedHead: nextSource.head,
    fromBaseBranch: 'prerelease',
    toBaseBranch: 'main',
    priorDeclaredBaseHead: initial.declaredBaseHead,
    reason,
    authority,
    beforeRef: 'refs/threadnote/cycles/requalification-before/' + digest,
    afterRef: 'refs/threadnote/cycles/requalification-after/' + digest,
    priorBaseRef: 'refs/threadnote/cycles/requalification-base/' + digest,
  };
  const next: NativeCycleSnapshot = {
    ...nextSource,
    baseRequalification: {
      ...qualification,
      receiptDigest: nativeCycleBaseRequalificationReceiptDigest(nextSource, qualification),
    },
  };
  return {
    state: initializeNativeCycle(currentPlan),
    plans: [oldPlan, currentPlan],
    baselines: {
      one: {repo: 'repo', head: object('a'), tree: initial.baseTree, preservedFiles: [], pinnedRef: 'baseline'},
    },
    reviewLimits: {one: 7},
    reviewExpansions: [{phaseId: 'one', from: 5, to: 7, authority}],
    snapshots: [
      {snapshot: initial, incoming: []},
      {snapshot: next, incoming: []},
    ],
    reviews: [
      {snapshotId: initial.snapshotId, report: report(initial)},
      {snapshotId: next.snapshotId, report: report(next)},
    ],
    attempts: [],
  };
};

describe('initial rebase and later base requalification compatibility', () => {
  it('round-trips both receipts together without changing history or authorization budgets', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ._-]{0,40}$/u),
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ._-]{0,40}$/u),
        (reason, authority) => {
          const value = runtime(reason, authority);
          const before = JSON.stringify(value);
          const input = JSON.parse(before);
          const inputBefore = JSON.stringify(input);
          expect(decodeNativeCycleRuntime(input)).toEqual(value);
          expect(JSON.stringify(input)).toBe(inputBefore);
          expect(JSON.stringify(value)).toBe(before);
          for (const index of [0, 1]) {
            const changed = {
              ...value,
              snapshots: EffectArray.map(value.snapshots, (entry, position) => {
                if (position !== index) return entry;
                const snapshot = entry.snapshot;
                return {
                  ...entry,
                  snapshot: {
                    ...snapshot,
                    ...(snapshot.rebase ? {rebase: {...snapshot.rebase, authority: authority + ' changed'}} : {}),
                    ...(snapshot.baseRequalification
                      ? {baseRequalification: {...snapshot.baseRequalification, authority: authority + ' changed'}}
                      : {}),
                  },
                };
              }),
            };
            expect(() => decodeNativeCycleRuntime(changed)).toThrow();
          }
        },
      ),
      {numRuns: 24},
    );
  });

  it('refuses combined receipts, reordered history and a later snapshot using the initial-rebase bypass', () => {
    const value = runtime('Approved source transition.', 'Explicit human approval.');
    const initial = value.snapshots[0];
    const next = value.snapshots[1];
    const mixed = {
      ...value,
      snapshots: [initial, {...next, snapshot: {...next.snapshot, rebase: initial.snapshot.rebase}}],
    };
    expect(() => decodeNativeCycleRuntime(mixed)).toThrow();
    const reordered = {...value, snapshots: [...value.snapshots].reverse()};
    expect(() => decodeNativeCycleRuntime(reordered)).toThrow();
    const {baseRequalification: _qualification, ...ordinary} = next.snapshot;
    const receipt = initial.snapshot.rebase;
    if (!receipt) throw new Error('Missing fixture receipt');
    const bypass = {
      ...value,
      snapshots: [
        initial,
        {
          ...next,
          snapshot: {
            ...ordinary,
            rebase: {...receipt, receiptDigest: nativeCycleRebaseReceiptDigest(ordinary, receipt)},
          },
        },
      ],
    };
    expect(() => decodeNativeCycleRuntime(bypass)).toThrow();
  });
});
