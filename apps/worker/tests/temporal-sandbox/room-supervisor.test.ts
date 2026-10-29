/**
 * roomAgentSupervisorWorkflow on the real time-skipping test server
 * (issue #60): enqueue/stop signals, one-second polling loops, interrupting
 * a running mission, continueAsNew with carried state, and both the current
 * (patched) and the pre-patch branches. Also covers every behavioural
 * assertion from the mocked room-supervisor-continuation.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL } from "@space/contracts";
import { ActivityStubs, blockUntilCancelled, buildActivities, makeGate } from "./activity-stubs.js";
import { supervisorInput, supervisorQueueItem } from "./stubs.js";
import {
  createSandboxEnv,
  MAIN_TASK_QUEUE,
  PRE_PATCH_TASK_QUEUE,
  ROOM_BACKGROUND_CONTINUATION_PATCH,
  waitForRunIdChange,
  type SandboxEnv
} from "./sandbox.js";

const stubs = new ActivityStubs();
let env: SandboxEnv;
const openHandles: Array<{ cancel(): Promise<void>; result(): Promise<unknown> }> = [];

beforeAll(async () => {
  env = await createSandboxEnv();
  await env.startWorker({ taskQueue: MAIN_TASK_QUEUE, activities: buildActivities(stubs) });
  // Production workflowsPath with the continuation patch forced off so the
  // live execution takes legacyRoomAgentSupervisorWorkflow without copying it.
  await env.startWorker({
    taskQueue: PRE_PATCH_TASK_QUEUE,
    activities: buildActivities(stubs),
    disablePatches: [ROOM_BACKGROUND_CONTINUATION_PATCH]
  });
}, 120000);

beforeEach(() => stubs.reset());

afterEach(async () => {
  // Cancel any still-open supervisors so a later testEnv.sleep keeps skipping
  // time (an orphaned pending activity silently falls back to wall clock).
  while (openHandles.length) {
    const handle = openHandles.pop()!;
    await handle.cancel().catch(() => undefined);
    await Promise.race([
      handle.result().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
  }
}, 30000);

afterAll(async () => {
  await env.teardown();
}, 60000);

async function startSupervisor(workflowId: string, input: unknown, taskQueue = MAIN_TASK_QUEUE) {
  const handle = await env.testEnv.client.workflow.start("roomAgentSupervisorWorkflow", {
    taskQueue,
    workflowId,
    args: [input]
  });
  openHandles.push(handle);
  return handle;
}

describe("roomAgentSupervisorWorkflow (current patched branch)", () => {
  it("runs an enqueued mission end to end (allocation → turn → finish)", async () => {
    const roomId = "room-sup-01";
    const item = supervisorQueueItem(roomId, "mission-0001", "a");

    const handle = await startSupervisor("sup-test-01", supervisorInput(roomId));
    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item);

    await stubs.waitForCall("finishRoomAgentSupervisorTurn");
    expect(stubs.count("checkRoomAgentSupervisorTurn")).toBe(1);
    expect(stubs.callsOf("checkRoomAgentSupervisorTurn")[0]).toMatchObject({ missionId: "mission-0001" });
    expect(stubs.callsOf("finishRoomAgentSupervisorTurn")[0]).toMatchObject({
      item: { missionId: "mission-0001" },
      status: "COMPLETED"
    });
    expect(stubs.count("discardRoomAgentSupervisorTurn")).toBe(0);

    await handle.cancel();
  }, 60000);

  it("moves a pending mission to the interrupted queue on a stop signal instead of running it", async () => {
    const roomId = "room-sup-02";
    const item1 = supervisorQueueItem(roomId, "mission-0002", "b");
    const item2 = supervisorQueueItem(roomId, "mission-0003", "c");
    const gate = makeGate();
    stubs.override("checkRoomAgentSupervisorTurn", async (input) => {
      if (input.missionId === "mission-0002") await gate.promise;
      return "READY";
    });

    const handle = await startSupervisor("sup-test-02", supervisorInput(roomId, { pending: [item1, item2] }));
    await stubs.waitForCall("checkRoomAgentSupervisorTurn");
    await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission-0003", reason: "Synthetic operator stop." });
    gate.open();

    await stubs.waitForCall("finishRoomAgentSupervisorTurn", 2);
    const finishCalls = stubs.callsOf("finishRoomAgentSupervisorTurn");
    expect(finishCalls[0]).toMatchObject({ item: { missionId: "mission-0002" }, status: "COMPLETED" });
    expect(finishCalls[1]).toMatchObject({
      item: { missionId: "mission-0003" },
      status: "INTERRUPTED",
      statusReason: "Synthetic operator stop."
    });
    expect(stubs.callsOf("discardRoomAgentSupervisorTurn")[0]).toMatchObject({
      item: { missionId: "mission-0003" },
      reason: "Synthetic operator stop."
    });

    await handle.cancel();
  }, 60000);

  it("interrupts a running mission on a stop signal and marks it INTERRUPTED", async () => {
    const roomId = "room-sup-03";
    const item = supervisorQueueItem(roomId, "mission-0004", "d");
    // Heartbeat until cancelled so the stop signal settles the activity cleanly
    // instead of leaving an orphaned pending record that disables time skipping.
    stubs.override("runCodexAppServerTurn", () => blockUntilCancelled());

    const handle = await startSupervisor("sup-test-03", supervisorInput(roomId, { pending: [item] }));
    await stubs.waitForCall("runCodexAppServerTurn");
    await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission-0004", reason: "Synthetic operator interruption." });

    await stubs.waitForCall("discardRoomAgentSupervisorTurn");
    await stubs.waitForCall("finishRoomAgentSupervisorTurn");
    expect(stubs.callsOf("finishRoomAgentSupervisorTurn")[0]).toMatchObject({
      item: { missionId: "mission-0004" },
      status: "INTERRUPTED",
      statusReason: "Synthetic operator interruption."
    });
    expect(stubs.callsOf("discardRoomAgentSupervisorTurn")[0]).toMatchObject({
      item: { missionId: "mission-0004" },
      reason: "Synthetic operator interruption."
    });

    await handle.cancel();
  }, 60000);

  it("records a failed child turn as FAILED with its cause code, never as superseded", async () => {
    const roomId = "room-sup-fail";
    const item = supervisorQueueItem(roomId, "mission-fail1", "fail");
    stubs.override("runCodexAppServerTurn", () => {
      throw Object.assign(new Error("child failed"), {
        name: "ApplicationFailure",
        type: "CODEX_APP_SERVER_TURN_TIMEOUT"
      });
    });

    const handle = await startSupervisor("sup-test-fail", supervisorInput(roomId, { pending: [item] }));
    await stubs.waitForCall("finishRoomAgentSupervisorTurn");
    expect(stubs.callsOf("finishRoomAgentSupervisorTurn")[0]).toMatchObject({
      item: { missionId: "mission-fail1" },
      status: "FAILED"
    });
    expect(stubs.callsOf("discardRoomAgentSupervisorTurn")[0]).toMatchObject({
      item: { missionId: "mission-fail1" }
    });
    await handle.cancel();
  }, 60000);

  it("re-queues a paused turn and re-checks it after the one-second wait", async () => {
    const roomId = "room-sup-04";
    const item = supervisorQueueItem(roomId, "mission-0005", "e");
    const states = ["PAUSED", "READY"];
    stubs.override("checkRoomAgentSupervisorTurn", (_input, index) => states[index]);

    const handle = await startSupervisor("sup-test-04", supervisorInput(roomId, { pending: [item] }));

    await stubs.waitForCall("checkRoomAgentSupervisorTurn", 2);
    await stubs.waitForCall("finishRoomAgentSupervisorTurn");
    expect(stubs.callsOf("finishRoomAgentSupervisorTurn")[0]).toMatchObject({ status: "COMPLETED" });

    await handle.cancel();
  }, 60000);

  it("prepares a monitored background continuation on the one-second poll loop and runs it", async () => {
    const roomId = "room-sup-05";
    const continuation = supervisorQueueItem(roomId, "mission-0006", "f");
    continuation.turn.roomAgentContinuation = { sourceRunId: "agent_run:room-sup-05-src", generation: 1 };
    stubs.override("prepareRoomAgentBackgroundContinuation", () => ({ state: "READY", item: continuation }));

    const handle = await startSupervisor("sup-test-05", supervisorInput(roomId, { monitoringMissionIds: ["mission-0006"] }));

    await stubs.waitForCall("prepareRoomAgentBackgroundContinuation");
    await stubs.waitForCall("checkRoomAgentSupervisorTurn");
    expect(stubs.callsOf("checkRoomAgentSupervisorTurn")[0]).toMatchObject({ missionId: "mission-0006" });
    await stubs.waitForCall("finishRoomAgentSupervisorTurn");
    expect(stubs.callsOf("finishRoomAgentSupervisorTurn")[0]).toMatchObject({
      item: { missionId: "mission-0006" },
      status: "COMPLETED"
    });

    await handle.cancel();
  }, 60000);

  it("discards a prepared continuation when a stop arrives before the activity reply", async () => {
    const roomId = "room-sup-race";
    const continuation = supervisorQueueItem(roomId, "mission-race1", "race");
    continuation.turn.roomAgentContinuation = { sourceRunId: "agent_run:room-sup-race-src", generation: 1 };
    const gate = makeGate();
    stubs.override("prepareRoomAgentBackgroundContinuation", async () => {
      await gate.promise;
      return { state: "READY", item: continuation };
    });

    const handle = await startSupervisor(
      "sup-test-race-stop",
      supervisorInput(roomId, { monitoringMissionIds: ["mission-race1"] })
    );
    await stubs.waitForCall("prepareRoomAgentBackgroundContinuation");
    await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission-race1", reason: "Stop during prepare." });
    gate.open();

    await stubs.waitForCall("discardRoomAgentSupervisorTurn");
    expect(stubs.callsOf("discardRoomAgentSupervisorTurn")[0]).toMatchObject({
      item: { missionId: "mission-race1" },
      reason: "Superseded while preparing the automatic continuation."
    });
    expect(stubs.count("checkRoomAgentSupervisorTurn")).toBe(0);

    await handle.cancel();
  }, 60000);

  it("continues as a new run with carried state after 50 processed missions", async () => {
    const roomId = "room-sup-06";
    const item1 = supervisorQueueItem(roomId, "mission-0007", "g");
    const item2 = supervisorQueueItem(roomId, "mission-0008", "h");

    const handle = await startSupervisor("sup-test-06", supervisorInput(roomId, { pending: [item1], processedCount: 49 }));
    // Capture the run id before the first turn: the continueAsNew after the
    // 50th processed mission can happen before waitForCall resolves.
    const firstRunId = (await handle.describe()).runId;
    await stubs.waitForCall("finishRoomAgentSupervisorTurn");
    await waitForRunIdChange(handle, firstRunId, 30000);

    // The continued run keeps working: enqueue another mission and watch it run.
    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item2);
    await stubs.waitForCall("checkRoomAgentSupervisorTurn", 2);
    expect(stubs.callsOf("checkRoomAgentSupervisorTurn")[1]).toMatchObject({ missionId: "mission-0008" });

    await handle.cancel();
  }, 90000);

  it("carries a prepared continuation through continueAsNew and starts it once", async () => {
    const roomId = "room-sup-carry";
    const continuation = supervisorQueueItem(roomId, "mission-carry", "carry");
    continuation.turn.roomAgentContinuation = { sourceRunId: "agent_run:room-sup-carry-src", generation: 1 };
    stubs.override("prepareRoomAgentBackgroundContinuation", () => ({ state: "READY", item: continuation }));

    // Start already at the 50-processed threshold so the run continues as new
    // after preparing the continuation, carrying it into the next run unstarted.
    const handle = await startSupervisor(
      "sup-test-carry",
      supervisorInput(roomId, { monitoringMissionIds: ["mission-carry"], processedCount: 50 })
    );
    const firstRunId = (await handle.describe()).runId;
    await stubs.waitForCall("prepareRoomAgentBackgroundContinuation");
    await waitForRunIdChange(handle, firstRunId, 30000);
    // The continued run must start the carried item exactly once.
    await stubs.waitForCall("checkRoomAgentSupervisorTurn");
    await stubs.waitForCall("finishRoomAgentSupervisorTurn");
    expect(stubs.count("checkRoomAgentSupervisorTurn")).toBe(1);
    expect(stubs.count("finishRoomAgentSupervisorTurn")).toBe(1);
    expect(stubs.count("prepareRoomAgentBackgroundContinuation")).toBe(1);

    await handle.cancel();
  }, 90000);

});

describe("roomAgentSupervisorWorkflow (pre-patch branch)", () => {
  it("finishes a completed mission and interrupts a stopped pending mission like a pre-patch execution", async () => {
    const roomId = "room-sup-08";
    const item1 = supervisorQueueItem(roomId, "mission-0010", "i");
    const item2 = supervisorQueueItem(roomId, "mission-0011", "j");
    const gate = makeGate();
    stubs.override("markRoomAgentMissionStarted", async (input) => {
      if (input.missionId === "mission-0010") await gate.promise;
      return null;
    });

    const handle = await startSupervisor(
      "sup-test-08-legacy",
      supervisorInput(roomId, { pending: [item1, item2] }),
      PRE_PATCH_TASK_QUEUE
    );
    await stubs.waitForCall("markRoomAgentMissionStarted");
    await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission-0011", reason: "Synthetic legacy stop." });
    gate.open();

    await stubs.waitForCall("markRoomAgentMissionFinished", 2);
    const finished = stubs.callsOf("markRoomAgentMissionFinished");
    expect(finished[0]).toMatchObject({ missionId: "mission-0010", status: "COMPLETED" });
    expect(finished[1]).toMatchObject({
      missionId: "mission-0011",
      status: "INTERRUPTED",
      statusReason: "Synthetic legacy stop."
    });
    expect(stubs.count("discardRoomAgentSupervisorTurn")).toBe(0);
    // Legacy path uses mark*/settle*, never the continuing-branch activities.
    expect(stubs.count("checkRoomAgentSupervisorTurn")).toBe(0);

    await handle.cancel();
  }, 60000);

  it("polls settleRoomAgentBackgroundMission on the legacy one-second loop", async () => {
    const roomId = "room-sup-09";
    stubs.override("settleRoomAgentBackgroundMission", () => true);

    const handle = await startSupervisor(
      "sup-test-09-legacy-settle",
      supervisorInput(roomId, { monitoringMissionIds: ["mission-0012"] }),
      PRE_PATCH_TASK_QUEUE
    );

    await stubs.waitForCall("settleRoomAgentBackgroundMission");
    expect(stubs.callsOf("settleRoomAgentBackgroundMission")[0]).toMatchObject({
      roomId,
      missionId: "mission-0012"
    });
    expect(stubs.count("checkRoomAgentSupervisorTurn")).toBe(0);
    expect(stubs.count("prepareRoomAgentBackgroundContinuation")).toBe(0);

    await handle.cancel();
  }, 60000);

  it("continues as a new run with carried state after 50 processed missions on the pre-patch branch", async () => {
    const roomId = "room-sup-10";
    const item1 = supervisorQueueItem(roomId, "mission-0013", "k");
    const item2 = supervisorQueueItem(roomId, "mission-0014", "l");

    const handle = await startSupervisor(
      "sup-test-10-legacy-can",
      supervisorInput(roomId, { pending: [item1], processedCount: 49 }),
      PRE_PATCH_TASK_QUEUE
    );
    const firstRunId = (await handle.describe()).runId;
    await stubs.waitForCall("markRoomAgentMissionFinished");
    await waitForRunIdChange(handle, firstRunId, 30000);

    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item2);
    await stubs.waitForCall("markRoomAgentMissionStarted", 2);
    expect(stubs.callsOf("markRoomAgentMissionStarted")[1]).toMatchObject({ missionId: "mission-0014" });

    await handle.cancel();
  }, 90000);

});
