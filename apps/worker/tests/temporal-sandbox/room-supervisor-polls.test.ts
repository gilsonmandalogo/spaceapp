/**
 * 250-poll continueAsNew coverage in an isolated time-skipping environment.
 * These tests need a clean test server: an orphaned pending activity from an
 * earlier suite silently disables time skipping and turns sleep() into wall clock.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActivityStubs, buildActivities } from "./activity-stubs.js";
import { supervisorInput } from "./stubs.js";
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
  await env.startWorker({
    taskQueue: PRE_PATCH_TASK_QUEUE,
    activities: buildActivities(stubs),
    disablePatches: [ROOM_BACKGROUND_CONTINUATION_PATCH]
  });
}, 120000);

beforeEach(() => stubs.reset());

afterEach(async () => {
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

async function startSupervisor(workflowId: string, input: unknown, taskQueue: string) {
  const handle = await env.testEnv.client.workflow.start("roomAgentSupervisorWorkflow", {
    taskQueue,
    workflowId,
    args: [input]
  });
  openHandles.push(handle);
  return handle;
}

describe("roomAgentSupervisorWorkflow 250-poll continueAsNew", () => {
  it("continues as a new run after 250 monitoring polls on the current branch", async () => {
    stubs.override("prepareRoomAgentBackgroundContinuation", () => ({ state: "WAITING" }));

    const handle = await startSupervisor(
      "sup-test-07",
      supervisorInput("room-sup-07", { monitoringMissionIds: ["mission-0009"] }),
      MAIN_TASK_QUEUE
    );
    const firstRunId = (await handle.describe()).runId;

    while (stubs.count("prepareRoomAgentBackgroundContinuation") < 250) {
      await env.testEnv.sleep("10 seconds");
    }
    await waitForRunIdChange(handle, firstRunId, 30000);
    expect(stubs.count("prepareRoomAgentBackgroundContinuation")).toBeGreaterThanOrEqual(250);

    await handle.cancel();
  }, 120000);

  it("continues as a new run after 250 monitoring polls on the pre-patch branch", async () => {
    stubs.override("settleRoomAgentBackgroundMission", () => false);

    const handle = await startSupervisor(
      "sup-test-11-legacy-polls",
      supervisorInput("room-sup-11", { monitoringMissionIds: ["mission-0015"] }),
      PRE_PATCH_TASK_QUEUE
    );
    const firstRunId = (await handle.describe()).runId;

    while (stubs.count("settleRoomAgentBackgroundMission") < 250) {
      await env.testEnv.sleep("10 seconds");
    }
    await waitForRunIdChange(handle, firstRunId, 30000);
    expect(stubs.count("settleRoomAgentBackgroundMission")).toBeGreaterThanOrEqual(250);

    await handle.cancel();
  }, 120000);
});
