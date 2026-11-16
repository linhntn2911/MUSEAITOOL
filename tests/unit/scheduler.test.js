"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { recalculateTimeline, resolveCollisions } = require("../../source/tiktok/scheduler");

test("Scheduler timeline calculation and collision resolution", async (t) => {
  const baseTime = new Date("2026-11-16T12:00:00.000Z");

  await t.test("Spaces native schedule jobs by intervalMinutes", () => {
    const jobs = [
      { id: "j1", accountId: "acc-1", schedule: { mode: "native_schedule", targetTime: null } },
      { id: "j2", accountId: "acc-1", schedule: { mode: "native_schedule", targetTime: null } },
      { id: "j3", accountId: "acc-1", schedule: { mode: "native_schedule", targetTime: null } }
    ];

    const result = recalculateTimeline(jobs, {
      baseTime,
      firstDelayMinutes: 15,
      intervalMinutes: 60
    });

    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].schedule.effectiveTime, "2026-11-16T12:15:00.000Z");
    assert.strictEqual(result[1].schedule.effectiveTime, "2026-11-16T13:15:00.000Z");
    assert.strictEqual(result[2].schedule.effectiveTime, "2026-11-16T14:15:00.000Z");
  });

  await t.test("Auto-shifts colliding target times to next valid slot", () => {
    // Two jobs with same scheduled time on same account
    const jobs = [
      { id: "j1", accountId: "acc-1", schedule: { mode: "native_schedule", targetTime: "2026-11-16T15:00:00.000Z" } },
      { id: "j2", accountId: "acc-1", schedule: { mode: "native_schedule", targetTime: "2026-11-16T15:10:00.000Z" } } // only 10m later, interval is 60m
    ];

    const result = resolveCollisions(jobs, { intervalMinutes: 60 });
    assert.strictEqual(result[0].schedule.effectiveTime, "2026-11-16T15:00:00.000Z");
    assert.strictEqual(result[1].schedule.effectiveTime, "2026-11-16T16:00:00.000Z");
  });

  await t.test("Does not delay jobs on distinct accounts", () => {
    const jobs = [
      { id: "j1", accountId: "acc-A", schedule: { mode: "native_schedule", targetTime: "2026-11-16T15:00:00.000Z" } },
      { id: "j2", accountId: "acc-B", schedule: { mode: "native_schedule", targetTime: "2026-11-16T15:00:00.000Z" } }
    ];

    const result = resolveCollisions(jobs, { intervalMinutes: 60 });
    // Distinct accounts can post at the same time
    assert.strictEqual(result[0].schedule.effectiveTime, "2026-11-16T15:00:00.000Z");
    assert.strictEqual(result[1].schedule.effectiveTime, "2026-11-16T15:00:00.000Z");
  });
});
