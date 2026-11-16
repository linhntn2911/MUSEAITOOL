"use strict";

function recalculateTimeline(jobs, options = {}) {
  const baseTime = options.baseTime ? new Date(options.baseTime) : new Date();
  const firstDelayMinutes = Math.max(0, parseInt(options.firstDelayMinutes, 10) || 0);
  const intervalMinutes = Math.max(1, parseInt(options.intervalMinutes, 10) || 60);

  // Group by account
  const byAccount = new Map();
  for (const job of jobs) {
    const acc = job.accountId || "unassigned";
    if (!byAccount.has(acc)) byAccount.set(acc, []);
    byAccount.get(acc).push(job);
  }

  const result = [];
  for (const [_, accJobs] of byAccount) {
    let nextAvailableTime = new Date(baseTime.getTime() + firstDelayMinutes * 60 * 1000);

    for (const job of accJobs) {
      const cloned = JSON.parse(JSON.stringify(job));
      if (!cloned.schedule) {
        cloned.schedule = { mode: "immediate", targetTime: null, effectiveTime: null };
      }

      if (cloned.schedule.mode === "native_schedule") {
        if (cloned.schedule.targetTime) {
          const target = new Date(cloned.schedule.targetTime);
          if (target > nextAvailableTime) {
            nextAvailableTime = target;
          }
        }
        cloned.schedule.effectiveTime = nextAvailableTime.toISOString();
        nextAvailableTime = new Date(nextAvailableTime.getTime() + intervalMinutes * 60 * 1000);
      } else {
        cloned.schedule.effectiveTime = null;
      }
      result.push(cloned);
    }
  }

  return result;
}

function resolveCollisions(jobs, options = {}) {
  const intervalMinutes = Math.max(1, parseInt(options.intervalMinutes, 10) || 60);
  const intervalMs = intervalMinutes * 60 * 1000;

  const byAccount = new Map();
  for (const job of jobs) {
    const acc = job.accountId || "unassigned";
    if (!byAccount.has(acc)) byAccount.set(acc, []);
    byAccount.get(acc).push(job);
  }

  const result = [];
  for (const [_, accJobs] of byAccount) {
    // Sort scheduled jobs by targetTime
    const scheduled = [];
    const others = [];
    for (const j of accJobs) {
      if (j.schedule?.mode === "native_schedule" && j.schedule?.targetTime) {
        scheduled.push(JSON.parse(JSON.stringify(j)));
      } else {
        others.push(JSON.parse(JSON.stringify(j)));
      }
    }

    scheduled.sort((a, b) => new Date(a.schedule.targetTime) - new Date(b.schedule.targetTime));

    let lastEffectiveTime = null;
    for (const job of scheduled) {
      let targetDate = new Date(job.schedule.targetTime);
      if (lastEffectiveTime && (targetDate.getTime() - lastEffectiveTime.getTime()) < intervalMs) {
        targetDate = new Date(lastEffectiveTime.getTime() + intervalMs);
      }
      job.schedule.effectiveTime = targetDate.toISOString();
      lastEffectiveTime = targetDate;
      result.push(job);
    }

    result.push(...others);
  }

  return result;
}

module.exports = {
  recalculateTimeline,
  resolveCollisions
};
