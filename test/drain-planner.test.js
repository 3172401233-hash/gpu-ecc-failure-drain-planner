import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  planDrain,
  assessGpu,
  correctableGrowthPerHour,
  isGpuAssignable,
  applyPlanToInventory,
} from '../src/drain-planner.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function rateHistory(correctableNow, spanMinutes = 60, startCount = 0) {
  return [
    { minutesAgo: spanMinutes, correctable: startCount, uncorrectable: 0 },
    { minutesAgo: 0, correctable: correctableNow, uncorrectable: 0 },
  ];
}

function sparePool(models, countPerModel = 6) {
  const spares = [];
  for (const model of models) {
    for (let index = 0; index < countPerModel; index += 1) {
      spares.push({ id: `spare-${model}-${index}`, model, faultDomain: 'rack-spare' });
    }
  }
  return spares;
}

test('correctable ECC growth: faster growth drains first with shorter risk window', () => {
  const input = {
    gpus: [
      { id: 'gpu-slow', model: 'A100', faultDomain: 'rack-a', eccHistory: rateHistory(12) },
      { id: 'gpu-fast', model: 'A100', faultDomain: 'rack-a', eccHistory: rateHistory(60) },
      { id: 'gpu-healthy', model: 'A100', faultDomain: 'rack-a', eccHistory: rateHistory(0) },
    ],
    tasks: [],
    spareGpus: [],
  };

  const plan = planDrain(input);

  assert.deepEqual(plan.drainOrder, ['gpu-fast', 'gpu-slow']);
  assert.equal(plan.gpuAssessments.find((g) => g.gpuId === 'gpu-healthy').drainRecommended, false);

  const fast = plan.riskWindows.find((window) => window.gpuId === 'gpu-fast');
  const slow = plan.riskWindows.find((window) => window.gpuId === 'gpu-slow');
  assert.ok(fast.safeWindowMinutes < slow.safeWindowMinutes);
  assert.equal(fast.safeWindowMinutes, 50);
  assert.equal(slow.safeWindowMinutes, 250);

  const fastAssessment = plan.gpuAssessments.find((g) => g.gpuId === 'gpu-fast');
  assert.equal(fastAssessment.severity, 'high');
  assert.equal(fastAssessment.correctableRatePerHour, 60);
});

test('correctable growth regression handles three samples', () => {
  const growth = correctableGrowthPerHour([
    { minutesAgo: 120, correctable: 0 },
    { minutesAgo: 60, correctable: 30 },
    { minutesAgo: 0, correctable: 60 },
  ]);
  assert.equal(growth.ratePerHour, 30);
  assert.equal(growth.reliable, true);
});

test('uncorrectable ECC errors are isolated before fast correctable growth', () => {
  const plan = planDrain({
    gpus: [
      { id: 'gpu-correctable-fast', model: 'A100', eccHistory: rateHistory(120) },
      {
        id: 'gpu-uncorrectable',
        model: 'A100',
        eccHistory: [
          { minutesAgo: 30, correctable: 2, uncorrectable: 0 },
          { minutesAgo: 0, correctable: 5, uncorrectable: 1 },
        ],
      },
    ],
    tasks: [],
    spareGpus: [],
  });

  assert.equal(plan.drainOrder[0], 'gpu-uncorrectable');
  const critical = plan.gpuAssessments.find((g) => g.gpuId === 'gpu-uncorrectable');
  assert.equal(critical.severity, 'critical');
  assert.equal(critical.drainWithinMinutes, 0);
  assert.match(critical.reasons.join(','), /UNCORRECTABLE_ECC/);
  assert.ok(plan.quarantinedGpuIds.includes('gpu-uncorrectable'));
});

test('critical Xid event forces critical isolation even without ECC counters', () => {
  const assessment = assessGpu({
    id: 'gpu-xid',
    eccHistory: [],
    xidEvents: [{ code: 79, minutesAgo: 2 }],
  });
  assert.equal(assessment.severity, 'critical');
  assert.equal(assessment.drainWithinMinutes, 0);
  assert.ok(assessment.reasons.some((reason) => reason.startsWith('CRITICAL_XID')));
});

test('insufficient spares: priority order gets spares, shortfall and blocked jobs reported', () => {
  const plan = planDrain({
    gpus: [
      { id: 'gpu-0', model: 'A100', faultDomain: 'rack-a', eccHistory: rateHistory(60) },
    ],
    tasks: ['job-1', 'job-2', 'job-3'].map((id) => ({
      id,
      gpuId: 'gpu-0',
      remainingMinutes: 9999,
      checkpoint: { available: true, ageMinutes: 3 },
    })),
    spareGpus: [
      { id: 'spare-a1', model: 'A100', faultDomain: 'rack-b' },
      { id: 'spare-h100', model: 'H100', faultDomain: 'rack-b' },
    ],
  });

  assert.equal(plan.migrations.length, 3);
  assert.deepEqual(
    plan.migrations.map((m) => [m.taskId, m.status, m.targetGpuId]),
    [
      ['job-1', 'planned', 'spare-a1'],
      ['job-2', 'blocked_no_spare', null],
      ['job-3', 'blocked_no_spare', null],
    ],
  );
  assert.equal(plan.summary.spareShortfall, 2);
  assert.equal(plan.spares.shortfall, 2);
  assert.deepEqual(plan.spares.availableSpareIds, ['spare-h100']);

  const window = plan.riskWindows[0];
  assert.ok(window.notes.includes('BLOCKED_BY_INSUFFICIENT_SPARES'));
});

test('missing checkpoint: bounded wait when ETA fits, unrecoverable when absent or too late', () => {
  const plan = planDrain({
    config: { maxUncheckpointedWaitMinutes: 30, migrationOverheadMinutes: 5 },
    gpus: [
      { id: 'gpu-degrading', model: 'A100', eccHistory: rateHistory(12) },
      {
        id: 'gpu-critical',
        model: 'A100',
        eccHistory: [{ minutesAgo: 0, correctable: 1, uncorrectable: 1 }],
      },
    ],
    tasks: [
      { id: 'job-no-checkpoint', gpuId: 'gpu-degrading', remainingMinutes: 500 },
      {
        id: 'job-soon-checkpoint',
        gpuId: 'gpu-degrading',
        remainingMinutes: 500,
        checkpoint: { available: false, nextCheckpointEtaMinutes: 10 },
      },
      {
        id: 'job-late-checkpoint',
        gpuId: 'gpu-degrading',
        remainingMinutes: 500,
        checkpoint: { available: false, nextCheckpointEtaMinutes: 120 },
      },
      {
        id: 'job-critical-eta',
        gpuId: 'gpu-critical',
        remainingMinutes: 500,
        checkpoint: { available: false, nextCheckpointEtaMinutes: 5 },
      },
    ],
    spareGpus: sparePool(['A100']),
  });

  const byId = Object.fromEntries(plan.migrations.map((m) => [m.taskId, m]));

  assert.equal(byId['job-soon-checkpoint'].action, 'wait_for_checkpoint');
  assert.equal(byId['job-soon-checkpoint'].waitMinutes, 10);
  assert.equal(byId['job-no-checkpoint'].action, 'restart_no_checkpoint');
  assert.equal(byId['job-late-checkpoint'].action, 'restart_no_checkpoint');
  assert.equal(byId['job-critical-eta'].action, 'restart_no_checkpoint');

  for (const migration of plan.migrations) {
    assert.ok(
      migration.waitMinutes <= plan.config.maxUncheckpointedWaitMinutes,
      `wait for ${migration.taskId} must stay bounded`,
    );
  }

  const unrecoverableIds = plan.unrecoverableJobs.map((job) => job.taskId).sort();
  assert.deepEqual(unrecoverableIds, [
    'job-critical-eta',
    'job-late-checkpoint',
    'job-no-checkpoint',
  ]);

  const noCheckpointJob = plan.unrecoverableJobs.find((j) => j.taskId === 'job-no-checkpoint');
  assert.ok(noCheckpointJob.reasons.includes('NO_NEXT_CHECKPOINT_ETA'));
  const lateJob = plan.unrecoverableJobs.find((j) => j.taskId === 'job-late-checkpoint');
  assert.ok(lateJob.reasons.includes('CHECKPOINT_WAIT_EXCEEDS_LIMIT'));
  const criticalJob = plan.unrecoverableJobs.find((j) => j.taskId === 'job-critical-eta');
  assert.ok(criticalJob.reasons.includes('CHECKPOINT_TOO_LATE_FOR_GPU_WINDOW'));
});

test('task finishing inside safe window completes in place without consuming a spare', () => {
  const plan = planDrain({
    gpus: [
      { id: 'gpu-elevated', model: 'A100', eccHistory: rateHistory(12) },
      {
        id: 'gpu-critical',
        model: 'A100',
        eccHistory: [{ minutesAgo: 0, correctable: 0, uncorrectable: 1 }],
      },
    ],
    tasks: [
      { id: 'job-short', gpuId: 'gpu-elevated', remainingMinutes: 20, checkpoint: null },
      {
        id: 'job-critical-short',
        gpuId: 'gpu-critical',
        remainingMinutes: 1,
        checkpoint: { available: true },
      },
    ],
    spareGpus: sparePool(['A100'], 2),
  });

  assert.equal(plan.inPlaceCompletions.length, 1);
  assert.equal(plan.inPlaceCompletions[0].taskId, 'job-short');
  assert.equal(plan.migrations.find((m) => m.taskId === 'job-short'), undefined);

  const criticalMigration = plan.migrations.find((m) => m.taskId === 'job-critical-short');
  assert.equal(criticalMigration.action, 'migrate_checkpoint');
  const criticalWindow = plan.riskWindows.find((w) => w.gpuId === 'gpu-critical');
  assert.equal(criticalWindow.riskExceeded, true);
});

test('migrated-away GPU is quarantined and cannot be reassigned', () => {
  const input = {
    gpus: [
      { id: 'gpu-bad', model: 'A100', eccHistory: rateHistory(60) },
      { id: 'gpu-healthy', model: 'A100', eccHistory: rateHistory(0) },
    ],
    tasks: [
      { id: 'job-1', gpuId: 'gpu-bad', remainingMinutes: 999, checkpoint: { available: true } },
    ],
    spareGpus: [{ id: 'spare-a1', model: 'A100', faultDomain: 'rack-b' }],
  };
  const plan = planDrain(input);

  assert.equal(isGpuAssignable('gpu-bad', plan), false);
  assert.equal(isGpuAssignable('spare-a1', plan), false);
  assert.equal(isGpuAssignable('gpu-healthy', plan), true);

  const inventory = applyPlanToInventory(input, plan);
  assert.ok(!inventory.assignableGpuIds.includes('gpu-bad'));
  assert.ok(!inventory.assignableGpuIds.includes('spare-a1'));
  assert.ok(inventory.assignableGpuIds.includes('gpu-healthy'));
  assert.deepEqual(inventory.quarantinedGpuIds, ['gpu-bad']);
});

test('spare placement prefers a different fault domain', () => {
  const plan = planDrain({
    gpus: [{ id: 'gpu-0', model: 'A100', faultDomain: 'rack-a', eccHistory: rateHistory(60) }],
    tasks: [
      { id: 'job-1', gpuId: 'gpu-0', remainingMinutes: 999, checkpoint: { available: true } },
    ],
    spareGpus: [
      { id: 'spare-same-domain', model: 'A100', faultDomain: 'rack-a' },
      { id: 'spare-other-domain', model: 'A100', faultDomain: 'rack-b' },
    ],
  });

  assert.equal(plan.migrations[0].targetGpuId, 'spare-other-domain');
  assert.equal(plan.migrations[0].sameFaultDomain, false);
});

test('CLI plans the example cluster and emits JSON', async () => {
  const cliPath = path.join(rootDir, 'src', 'cli.js');
  const examplePath = path.join(rootDir, 'examples', 'cluster.json');
  const { stdout } = await execFileAsync(process.execPath, [cliPath, examplePath]);
  const plan = JSON.parse(stdout);

  assert.equal(plan.drainOrder[0], 'gpu-0');
  assert.ok(plan.drainOrder.includes('gpu-1'));
  assert.equal(plan.summary.spareShortfall, 1);
  assert.ok(plan.unrecoverableJobs.some((job) => job.taskId === 'job-beta'));
});

test('README states the planner never accesses real GPUs', async () => {
  const readme = await readFile(path.join(rootDir, 'README.md'), 'utf8');
  assert.match(readme, /不访问真实 GPU/);
  assert.match(readme, /node --test/);
});
