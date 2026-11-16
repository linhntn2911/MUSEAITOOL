"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  JOB_STATUSES,
  canTransition,
  calculateProgress,
  isSafePauseBoundary
} = require("../../source/models/state-machine");

test("State machine transitions and rules", async (t) => {
  await t.test("Allows valid standard forward progression", () => {
    assert.ok(canTransition(JOB_STATUSES.DRAFT, JOB_STATUSES.WAITING_CONTENT));
    assert.ok(canTransition(JOB_STATUSES.WAITING_CONTENT, JOB_STATUSES.GENERATING_CONTENT));
    assert.ok(canTransition(JOB_STATUSES.GENERATING_CONTENT, JOB_STATUSES.WAITING_PRODUCT));
    assert.ok(canTransition(JOB_STATUSES.WAITING_PRODUCT, JOB_STATUSES.CHECKING_PRODUCT));
    assert.ok(canTransition(JOB_STATUSES.CHECKING_PRODUCT, JOB_STATUSES.WAITING_PRODUCT_CONFIRMATION));
    assert.ok(canTransition(JOB_STATUSES.WAITING_PRODUCT_CONFIRMATION, JOB_STATUSES.PROCESSING_AUDIO));
    assert.ok(canTransition(JOB_STATUSES.PROCESSING_AUDIO, JOB_STATUSES.READY));
    assert.ok(canTransition(JOB_STATUSES.READY, JOB_STATUSES.OPENING_STUDIO));
    assert.ok(canTransition(JOB_STATUSES.OPENING_STUDIO, JOB_STATUSES.UPLOADING));
    assert.ok(canTransition(JOB_STATUSES.UPLOADING, JOB_STATUSES.FILLING_METADATA));
    assert.ok(canTransition(JOB_STATUSES.FILLING_METADATA, JOB_STATUSES.CONFIGURING_SCHEDULE));
    assert.ok(canTransition(JOB_STATUSES.CONFIGURING_SCHEDULE, JOB_STATUSES.SUBMITTING));
    assert.ok(canTransition(JOB_STATUSES.SUBMITTING, JOB_STATUSES.POSTED));
    assert.ok(canTransition(JOB_STATUSES.SUBMITTING, JOB_STATUSES.SCHEDULED));
  });

  await t.test("Handles needs_reconciliation transition from submitting", () => {
    assert.ok(canTransition(JOB_STATUSES.SUBMITTING, JOB_STATUSES.NEEDS_RECONCILIATION));
    assert.ok(canTransition(JOB_STATUSES.NEEDS_RECONCILIATION, JOB_STATUSES.POSTED));
    assert.ok(canTransition(JOB_STATUSES.NEEDS_RECONCILIATION, JOB_STATUSES.SCHEDULED));
    assert.ok(canTransition(JOB_STATUSES.NEEDS_RECONCILIATION, JOB_STATUSES.READY));
  });

  await t.test("Rejects invalid backward or out-of-order jumps", () => {
    assert.strictEqual(canTransition(JOB_STATUSES.DRAFT, JOB_STATUSES.SUBMITTING), false);
    assert.strictEqual(canTransition(JOB_STATUSES.POSTED, JOB_STATUSES.DRAFT), false);
    assert.strictEqual(canTransition(JOB_STATUSES.SCHEDULED, JOB_STATUSES.READY), false);
  });

  await t.test("Progress reaches 100% ONLY when evidence is confirmed", () => {
    assert.strictEqual(calculateProgress(JOB_STATUSES.DRAFT), 0);
    assert.strictEqual(calculateProgress(JOB_STATUSES.READY), 50);
    assert.strictEqual(calculateProgress(JOB_STATUSES.SUBMITTING), 95);

    // Posted without evidence remains capped at 95%
    assert.strictEqual(calculateProgress(JOB_STATUSES.POSTED, []), 95);

    // Posted with evidence confirmed reaches 100%
    const validEvidence = [{ type: "post_confirmed", evidenceId: "ev-123" }];
    assert.strictEqual(calculateProgress(JOB_STATUSES.POSTED, validEvidence), 100);

    const validScheduleEvidence = [{ type: "schedule_confirmed", evidenceId: "ev-456" }];
    assert.strictEqual(calculateProgress(JOB_STATUSES.SCHEDULED, validScheduleEvidence), 100);
  });

  await t.test("Identifies safe pause boundaries", () => {
    assert.ok(isSafePauseBoundary(JOB_STATUSES.DRAFT));
    assert.ok(isSafePauseBoundary(JOB_STATUSES.READY));
    assert.ok(isSafePauseBoundary(JOB_STATUSES.WAITING_CONTENT));
    assert.strictEqual(isSafePauseBoundary(JOB_STATUSES.UPLOADING), false);
    assert.strictEqual(isSafePauseBoundary(JOB_STATUSES.SUBMITTING), false);
  });
});
