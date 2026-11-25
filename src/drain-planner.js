export const SEVERITY_ORDER = ['critical', 'high', 'elevated', 'watch', 'healthy'];

export const SEVERITY_RANK = Object.fromEntries(
  SEVERITY_ORDER.map((severity, index) => [severity, index]),
);

export const DEFAULT_CONFIG = Object.freeze({
  rateHighPerHour: 40,
  rateElevatedPerHour: 10,
  correctableErrorBudget: 50,
  minDrainMinutes: 15,
  maxDrainMinutes: 480,
  unknownRateDrainMinutes: 120,
  watchDrainMinutes: 240,
  warningXidDrainCapMinutes: 120,
  criticalDrainMinutes: 0,
  maxUncheckpointedWaitMinutes: 30,
  migrationOverheadMinutes: 5,
  checkpointMaxAgeMinutes: 60,
  allowCompleteInPlace: true,
  criticalXidCodes: Object.freeze([48, 79]),
  warningXidCodes: Object.freeze([63, 64, 92, 94]),
});

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function unique(values) {
  return [...new Set(values)];
}

export function correctableGrowthPerHour(eccHistory) {
  const samples = Array.isArray(eccHistory) ? eccHistory : [];
  if (samples.length < 2) {
    return { ratePerHour: 0, reliable: false, counterReset: false, sampleCount: samples.length };
  }

  const ages = samples.map((sample) => numberOrNull(sample.minutesAgo) ?? 0);
  const maxAge = Math.max(...ages);
  const points = samples.map((sample, index) => ({
    x: (maxAge - ages[index]) / 60,
    y: numberOrNull(sample.correctable ?? sample.correctableCount) ?? 0,
  }));

  const count = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
    sumXY += point.x * point.y;
    sumXX += point.x * point.x;
  }

  const denominator = count * sumXX - sumX * sumX;
  let slope = denominator === 0
    ? (points[count - 1].y - points[0].y) / Math.max(points[count - 1].x - points[0].x, 1 / 60)
    : (count * sumXY - sumX * sumY) / denominator;

  let counterReset = false;
  if (slope < 0) {
    counterReset = true;
    slope = 0;
  }

  return {
    ratePerHour: Math.max(0, slope),
    reliable: !counterReset,
    counterReset,
    sampleCount: count,
  };
}

function latestSample(eccHistory) {
  const samples = Array.isArray(eccHistory) ? eccHistory : [];
  if (samples.length === 0) return null;
  return samples.reduce((newest, sample) => {
    const newestAge = numberOrNull(newest.minutesAgo) ?? Number.POSITIVE_INFINITY;
    const sampleAge = numberOrNull(sample.minutesAgo) ?? Number.POSITIVE_INFINITY;
    return sampleAge < newestAge ? sample : newest;
  });
}

function bumpSeverity(severity) {
  if (severity === 'watch') return 'elevated';
  if (severity === 'elevated') return 'high';
  return severity;
}

export function assessGpu(gpu, config = DEFAULT_CONFIG) {
  const history = Array.isArray(gpu.eccHistory) ? gpu.eccHistory : [];
  const latest = latestSample(history);
  const correctableTotal = numberOrNull(latest?.correctable ?? gpu.correctableErrors) ?? 0;
  const uncorrectableTotal = numberOrNull(latest?.uncorrectable ?? gpu.uncorrectableErrors) ?? 0;
  const growth = correctableGrowthPerHour(history);

  const xidEvents = Array.isArray(gpu.xidEvents) ? gpu.xidEvents : [];
  const criticalXids = unique(
    xidEvents
      .map((event) => numberOrNull(event.code ?? event.xid))
      .filter((code) => code !== null && config.criticalXidCodes.includes(code)),
  );
  const warningXids = unique(
    xidEvents
      .map((event) => numberOrNull(event.code ?? event.xid))
      .filter((code) => code !== null && config.warningXidCodes.includes(code)),
  );

  const reasons = [];
  let severity = 'healthy';
  let drainWithinMinutes = null;

  if (uncorrectableTotal > 0) {
    severity = 'critical';
    drainWithinMinutes = config.criticalDrainMinutes;
    reasons.push('UNCORRECTABLE_ECC');
  }
  if (criticalXids.length > 0) {
    severity = 'critical';
    drainWithinMinutes = config.criticalDrainMinutes;
    reasons.push(`CRITICAL_XID:${criticalXids.join('|')}`);
  }

  if (severity !== 'critical') {
    const hasSignal = correctableTotal > 0 || growth.ratePerHour > 0 || warningXids.length > 0;

    if (hasSignal) {
      if (growth.ratePerHour >= config.rateHighPerHour) {
        severity = 'high';
      } else if (growth.ratePerHour >= config.rateElevatedPerHour) {
        severity = 'elevated';
      } else if (growth.ratePerHour > 0) {
        severity = 'watch';
      } else {
        severity = 'watch';
      }

      if (growth.ratePerHour > 0) {
        const rateDrivenWindow = (config.correctableErrorBudget / growth.ratePerHour) * 60;
        drainWithinMinutes = clamp(
          Math.round(rateDrivenWindow),
          config.minDrainMinutes,
          config.maxDrainMinutes,
        );
        reasons.push('CORRECTABLE_GROWTH_RATE');
      } else if (!growth.reliable && correctableTotal > 0) {
        drainWithinMinutes = config.unknownRateDrainMinutes;
        reasons.push('GROWTH_RATE_UNRELIABLE');
      } else {
        drainWithinMinutes = config.watchDrainMinutes;
        reasons.push('CORRECTABLE_ERRORS_PRESENT');
      }

      if (warningXids.length > 0) {
        severity = bumpSeverity(severity);
        drainWithinMinutes = Math.min(drainWithinMinutes, config.warningXidDrainCapMinutes);
        reasons.push(`WARNING_XID:${warningXids.join('|')}`);
      }
    }
  }

  return {
    gpuId: gpu.id,
    model: gpu.model ?? null,
    faultDomain: gpu.faultDomain ?? null,
    severity,
    severityRank: SEVERITY_RANK[severity],
    drainRecommended: severity !== 'healthy',
    drainWithinMinutes,
    correctableTotal,
    uncorrectableTotal,
    correctableRatePerHour: Number(growth.ratePerHour.toFixed(3)),
    rateReliable: growth.reliable,
    counterReset: growth.counterReset,
    eccSampleCount: growth.sampleCount,
    criticalXidCodes: criticalXids,
    warningXidCodes: warningXids,
    reasons,
  };
}

function checkpointState(task, config) {
  const checkpoint = task.checkpoint ?? null;
  const hasCheckpoint = Boolean(checkpoint && checkpoint.available !== false);
  const nextCheckpointEtaMinutes = numberOrNull(checkpoint?.nextCheckpointEtaMinutes);
  const checkpointAgeMinutes = numberOrNull(checkpoint?.ageMinutes);
  const stale = hasCheckpoint
    && checkpointAgeMinutes !== null
    && checkpointAgeMinutes > config.checkpointMaxAgeMinutes;
  return { hasCheckpoint, nextCheckpointEtaMinutes, checkpointAgeMinutes, stale };
}

export function decideTaskAction(task, assessment, config = DEFAULT_CONFIG) {
  const checkpoint = checkpointState(task, config);
  const overhead = numberOrNull(task.migrationOverheadMinutes) ?? config.migrationOverheadMinutes;
  const remainingMinutes = numberOrNull(task.remainingMinutes);
  const safeWindow = assessment.drainWithinMinutes ?? Number.POSITIVE_INFINITY;
  const reasonCodes = [];

  if (
    config.allowCompleteInPlace
    && assessment.severity !== 'critical'
    && remainingMinutes !== null
    && remainingMinutes <= safeWindow
  ) {
    return {
      action: 'complete_in_place',
      needsSpare: false,
      recoverable: true,
      waitMinutes: 0,
      overheadMinutes: 0,
      exposureEndMinutes: remainingMinutes,
      reasonCodes: ['COMPLETES_WITHIN_RISK_WINDOW'],
      unrecoverableReasons: [],
      checkpoint,
    };
  }

  if (checkpoint.hasCheckpoint) {
    if (checkpoint.stale) reasonCodes.push('STALE_CHECKPOINT');
    return {
      action: 'migrate_checkpoint',
      needsSpare: true,
      recoverable: true,
      waitMinutes: 0,
      overheadMinutes: overhead,
      exposureEndMinutes: overhead,
      reasonCodes,
      unrecoverableReasons: [],
      checkpoint,
    };
  }

  const taskMaxWait = numberOrNull(task.maxWaitMinutes);
  const maxWaitMinutes = taskMaxWait === null
    ? config.maxUncheckpointedWaitMinutes
    : Math.min(config.maxUncheckpointedWaitMinutes, taskMaxWait);
  const eta = checkpoint.nextCheckpointEtaMinutes;

  if (eta === null) {
    reasonCodes.push('NO_CHECKPOINT', 'NO_NEXT_CHECKPOINT_ETA');
  } else if (eta > maxWaitMinutes) {
    reasonCodes.push('NO_CHECKPOINT', 'CHECKPOINT_WAIT_EXCEEDS_LIMIT');
  } else if (eta + overhead > safeWindow) {
    reasonCodes.push('NO_CHECKPOINT', 'CHECKPOINT_TOO_LATE_FOR_GPU_WINDOW');
  } else {
    return {
      action: 'wait_for_checkpoint',
      needsSpare: true,
      recoverable: true,
      waitMinutes: eta,
      overheadMinutes: overhead,
      exposureEndMinutes: eta + overhead,
      reasonCodes: ['WAIT_FOR_CHECKPOINT'],
      unrecoverableReasons: [],
      checkpoint,
    };
  }

  return {
    action: 'restart_no_checkpoint',
    needsSpare: true,
    recoverable: false,
    waitMinutes: 0,
    overheadMinutes: overhead,
    exposureEndMinutes: overhead,
    maxWaitMinutes,
    reasonCodes,
    unrecoverableReasons: reasonCodes.filter((code) => code !== 'NO_CHECKPOINT'),
    checkpoint,
  };
}

function spareCompatible(spare, gpu, task) {
  const requiredModel = task?.requiredModel ?? null;
  if (requiredModel) {
    if (spare.model === requiredModel) return true;
    return Array.isArray(spare.compatibleModels) && spare.compatibleModels.includes(requiredModel);
  }
  if (spare.model === undefined || spare.model === null || gpu.model === undefined || gpu.model === null) {
    return true;
  }
  if (spare.model === gpu.model) return true;
  if (Array.isArray(spare.compatibleModels) && spare.compatibleModels.includes(gpu.model)) return true;
  if (Array.isArray(gpu.compatibleSpareModels) && gpu.compatibleSpareModels.includes(spare.model)) return true;
  return false;
}

function chooseSpare(spares, usedSpareIds, faultDomainLoad, gpu, task) {
  const candidates = spares.filter((spare) => !usedSpareIds.has(spare.id) && spareCompatible(spare, gpu, task));
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const sameDomainA = a.faultDomain != null && a.faultDomain === gpu.faultDomain ? 1 : 0;
    const sameDomainB = b.faultDomain != null && b.faultDomain === gpu.faultDomain ? 1 : 0;
    if (sameDomainA !== sameDomainB) return sameDomainA - sameDomainB;

    const loadA = faultDomainLoad[a.faultDomain ?? '__unknown__'] ?? 0;
    const loadB = faultDomainLoad[b.faultDomain ?? '__unknown__'] ?? 0;
    if (loadA !== loadB) return loadA - loadB;

    return String(a.id).localeCompare(String(b.id));
  });

  return candidates[0];
}

export function planDrain(input = {}) {
  const config = { ...DEFAULT_CONFIG, ...(input.config ?? {}) };
  const gpus = Array.isArray(input.gpus) ? input.gpus : [];
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const spares = Array.isArray(input.spareGpus)
    ? input.spareGpus
    : Array.isArray(input.spares)
      ? input.spares
      : [];

  const inputWarnings = [];
  const gpuById = new Map();
  for (const gpu of gpus) {
    if (!gpu || gpu.id === undefined || gpu.id === null) {
      inputWarnings.push('GPU_ENTRY_WITHOUT_ID_IGNORED');
      continue;
    }
    gpuById.set(gpu.id, gpu);
  }

  const tasksByGpuId = new Map();
  const orphanTaskIds = [];
  for (const task of tasks) {
    if (!task || task.id === undefined || task.id === null) {
      inputWarnings.push('TASK_ENTRY_WITHOUT_ID_IGNORED');
      continue;
    }
    if (!gpuById.has(task.gpuId)) {
      orphanTaskIds.push(task.id);
      inputWarnings.push(`TASK_${task.id}_REFERENCES_UNKNOWN_GPU_${task.gpuId}`);
      continue;
    }
    if (!tasksByGpuId.has(task.gpuId)) tasksByGpuId.set(task.gpuId, []);
    tasksByGpuId.get(task.gpuId).push(task);
  }

  const assessments = gpus
    .filter((gpu) => gpu && gpu.id !== undefined && gpu.id !== null)
    .map((gpu) => ({
      ...assessGpu(gpu, config),
      taskCount: tasksByGpuId.get(gpu.id)?.length ?? 0,
    }));
  const assessmentById = new Map(assessments.map((assessment) => [assessment.gpuId, assessment]));

  const faultDomainDrainCount = {};
  for (const assessment of assessments) {
    if (assessment.drainRecommended && assessment.faultDomain != null) {
      faultDomainDrainCount[assessment.faultDomain] = (faultDomainDrainCount[assessment.faultDomain] ?? 0) + 1;
    }
  }

  const drainOrder = assessments
    .filter((assessment) => assessment.drainRecommended)
    .sort((a, b) => {
      if (a.severityRank !== b.severityRank) return a.severityRank - b.severityRank;
      if (b.correctableRatePerHour !== a.correctableRatePerHour) {
        return b.correctableRatePerHour - a.correctableRatePerHour;
      }
      if (b.uncorrectableTotal !== a.uncorrectableTotal) {
        return b.uncorrectableTotal - a.uncorrectableTotal;
      }
      const domainCountA = faultDomainDrainCount[a.faultDomain] ?? 0;
      const domainCountB = faultDomainDrainCount[b.faultDomain] ?? 0;
      if (domainCountB !== domainCountA) return domainCountB - domainCountA;
      if (b.taskCount !== a.taskCount) return b.taskCount - a.taskCount;
      return String(a.gpuId).localeCompare(String(b.gpuId));
    })
    .map((assessment) => assessment.gpuId);

  const drainIndex = new Map(drainOrder.map((gpuId, index) => [gpuId, index]));

  const taskActions = [];
  for (const gpuId of drainOrder) {
    const assessment = assessmentById.get(gpuId);
    const gpu = gpuById.get(gpuId);
    for (const task of tasksByGpuId.get(gpuId) ?? []) {
      const decision = decideTaskAction(task, assessment, config);
      taskActions.push({ task, gpu, gpuId, assessment, decision });
    }
  }

  const allocationCandidates = taskActions
    .filter((entry) => entry.decision.needsSpare)
    .sort((a, b) => {
      const indexDifference = drainIndex.get(a.gpuId) - drainIndex.get(b.gpuId);
      if (indexDifference !== 0) return indexDifference;
      const priorityA = numberOrNull(a.task.priority) ?? 0;
      const priorityB = numberOrNull(b.task.priority) ?? 0;
      const priorityDifference = priorityB - priorityA;
      if (priorityDifference !== 0) return priorityDifference;
      if (a.decision.recoverable !== b.decision.recoverable) {
        return a.decision.recoverable ? -1 : 1;
      }
      return String(a.task.id).localeCompare(String(b.task.id));
    });

  const usedSpareIds = new Set();
  const faultDomainLoad = {};
  const allocationByTaskId = new Map();

  for (const entry of allocationCandidates) {
    const spare = chooseSpare(spares, usedSpareIds, faultDomainLoad, entry.gpu, entry.task);
    if (!spare) {
      allocationByTaskId.set(entry.task.id, { targetGpuId: null, sameFaultDomain: false });
      continue;
    }
    usedSpareIds.add(spare.id);
    const domain = spare.faultDomain ?? '__unknown__';
    faultDomainLoad[domain] = (faultDomainLoad[domain] ?? 0) + 1;
    allocationByTaskId.set(entry.task.id, {
      targetGpuId: spare.id,
      sameFaultDomain: spare.faultDomain != null && spare.faultDomain === entry.gpu.faultDomain,
    });
  }

  const migrations = [];
  const inPlaceCompletions = [];
  const unrecoverableJobs = [];

  for (const gpuId of drainOrder) {
    const entries = taskActions.filter((entry) => entry.gpuId === gpuId);
    for (const entry of entries) {
      const { task, decision } = entry;
      if (decision.action === 'complete_in_place') {
        inPlaceCompletions.push({
          taskId: task.id,
          gpuId,
          action: decision.action,
          remainingMinutes: numberOrNull(task.remainingMinutes),
          exposureEndMinutes: decision.exposureEndMinutes,
          reasonCodes: decision.reasonCodes,
        });
        continue;
      }

      const allocation = allocationByTaskId.get(task.id) ?? { targetGpuId: null, sameFaultDomain: false };
      const status = allocation.targetGpuId ? 'planned' : 'blocked_no_spare';
      const migration = {
        taskId: task.id,
        gpuId,
        model: entry.assessment.model,
        faultDomain: entry.assessment.faultDomain,
        action: decision.action,
        status,
        targetGpuId: allocation.targetGpuId,
        sameFaultDomain: allocation.sameFaultDomain,
        waitMinutes: decision.waitMinutes,
        migrationOverheadMinutes: decision.overheadMinutes,
        exposureEndMinutes: status === 'blocked_no_spare'
          ? entry.assessment.drainWithinMinutes
          : decision.exposureEndMinutes,
        recoverable: decision.recoverable,
        checkpointAvailable: decision.checkpoint.hasCheckpoint,
        checkpointAgeMinutes: decision.checkpoint.checkpointAgeMinutes,
        reasonCodes: decision.reasonCodes,
      };
      migrations.push(migration);

      if (!decision.recoverable) {
        unrecoverableJobs.push({
          taskId: task.id,
          gpuId,
          targetGpuId: allocation.targetGpuId,
          migrationStatus: status,
          lostProgress: true,
          reasons: decision.unrecoverableReasons,
          advice: allocation.targetGpuId
            ? 'Restart workload from scratch on assigned spare; prior progress cannot be restored.'
            : 'No recoverable checkpoint in safe window and no compatible spare; progress is lost and job stays exposed until isolation.',
        });
      }
    }
  }

  const riskWindows = drainOrder.map((gpuId) => {
    const assessment = assessmentById.get(gpuId);
    const gpuMigrations = migrations.filter((migration) => migration.gpuId === gpuId);
    const gpuCompletions = inPlaceCompletions.filter((item) => item.gpuId === gpuId);
    const exposedTaskIds = [
      ...gpuMigrations.map((migration) => migration.taskId),
      ...gpuCompletions.map((item) => item.taskId),
    ];
    const plannedClearMinute = exposedTaskIds.length === 0
      ? 0
      : Math.max(
        ...gpuMigrations.map((migration) => migration.exposureEndMinutes),
        ...gpuCompletions.map((item) => item.exposureEndMinutes),
      );
    const safeWindowMinutes = assessment.drainWithinMinutes ?? 0;
    const withinSafeWindow = plannedClearMinute <= safeWindowMinutes + 1e-9;
    const notes = [];
    if (!withinSafeWindow) notes.push('EVACUATION_EXCEEDS_POLICY_WINDOW');
    if (assessment.severity === 'critical') notes.push('ISOLATE_IMMEDIATELY_RESIDUAL_MIGRATION_RISK');
    if (gpuMigrations.some((migration) => migration.status === 'blocked_no_spare')) {
      notes.push('BLOCKED_BY_INSUFFICIENT_SPARES');
    }
    if (gpuMigrations.some((migration) => migration.sameFaultDomain)) {
      notes.push('MIGRATION_TARGET_IN_SAME_FAULT_DOMAIN');
    }

    return {
      gpuId,
      model: assessment.model,
      faultDomain: assessment.faultDomain,
      severity: assessment.severity,
      windowStartMinute: 0,
      safeWindowMinutes,
      plannedClearMinute: Number(plannedClearMinute.toFixed(2)),
      withinSafeWindow,
      riskExceeded: !withinSafeWindow,
      exposedTaskIds,
      notes: unique(notes),
    };
  });

  const quarantinedGpuIds = [...drainOrder];
  const assignedSpareIds = migrations.map((migration) => migration.targetGpuId).filter(Boolean);
  const availableSpareIds = spares
    .map((spare) => spare.id)
    .filter((id) => !usedSpareIds.has(id));
  const blockedMigrations = migrations.filter((migration) => migration.status === 'blocked_no_spare');
  const stableTaskIds = tasks
    .filter((task) => task && task.id !== undefined && gpuById.has(task.gpuId) && !drainIndex.has(task.gpuId))
    .map((task) => task.id);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    planner: 'gpu-ecc-drain-planner',
    nodeVersion: process.version,
    config,
    drainOrder,
    gpuAssessments: assessments,
    migrations,
    inPlaceCompletions,
    riskWindows,
    unrecoverableJobs,
    quarantinedGpuIds,
    orphanTaskIds,
    stableTaskIds,
    inputWarnings: unique(inputWarnings),
    spares: {
      total: spares.length,
      usedSpareIds: [...usedSpareIds],
      availableSpareIds,
      shortfall: blockedMigrations.length,
    },
    summary: {
      gpuCount: gpus.length,
      drainingGpuCount: drainOrder.length,
      criticalGpuCount: assessments.filter((assessment) => assessment.severity === 'critical').length,
      taskCount: tasks.length,
      migrationCount: migrations.length,
      plannedMigrationCount: migrations.filter((migration) => migration.status === 'planned').length,
      blockedMigrationCount: blockedMigrations.length,
      completeInPlaceCount: inPlaceCompletions.length,
      unrecoverableJobCount: unrecoverableJobs.length,
      spareCount: spares.length,
      spareShortfall: blockedMigrations.length,
      riskExceededWindowCount: riskWindows.filter((window) => window.riskExceeded).length,
    },
  };
}

export function isGpuAssignable(gpuId, plan) {
  if (!plan || !Array.isArray(plan.quarantinedGpuIds)) return true;
  if (plan.quarantinedGpuIds.includes(gpuId)) return false;
  const occupiedAsSpare = (plan.migrations ?? []).some((migration) => migration.targetGpuId === gpuId);
  return !occupiedAsSpare;
}

export function applyPlanToInventory(input = {}, plan) {
  const sourceGpuIds = (Array.isArray(input.gpus) ? input.gpus : [])
    .map((gpu) => gpu?.id)
    .filter((id) => id !== undefined && id !== null);
  const spareIds = (Array.isArray(input.spareGpus) ? input.spareGpus : Array.isArray(input.spares) ? input.spares : [])
    .map((spare) => spare?.id)
    .filter((id) => id !== undefined && id !== null);

  const quarantinedGpuIds = [...(plan?.quarantinedGpuIds ?? [])];
  const occupiedSpareIds = (plan?.migrations ?? [])
    .map((migration) => migration.targetGpuId)
    .filter((id) => id !== null && id !== undefined);
  const quarantineSet = new Set(quarantinedGpuIds);
  const occupiedSet = new Set(occupiedSpareIds);

  const assignableGpuIds = [...sourceGpuIds, ...spareIds]
    .filter((id) => !quarantineSet.has(id) && !occupiedSet.has(id));

  return {
    assignableGpuIds,
    quarantinedGpuIds,
    occupiedSpareIds: unique(occupiedSpareIds),
  };
}
