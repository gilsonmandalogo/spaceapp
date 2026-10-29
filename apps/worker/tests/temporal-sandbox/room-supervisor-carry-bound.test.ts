/**
 * Carry-bound continueAsNew coverage in an isolated time-skipping environment
 * so the large pending drain cannot degrade later sleep()-based tests.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROOM_AGENT_ENQUEUE_SIGNAL } from "@space/contracts";
import { ActivityStubs, buildActivities, makeGate } from "./activity-stubs.js";
import { supervisorInput, supervisorQueueItem } from "./stubs.js";
import {
  createSandboxEnv,
  MAIN_TASK_QUEUE,
  waitForRunIdChange,
  type SandboxEnv
} from "./sandbox.js";

const stubs = new ActivityStubs();
let env: SandboxEnv;
const openHandles: Array<{ cancel(): Promise<void>; result(): Promise<unknown> }> = [];

beforeAll(async () => {
  env = await createSandboxEnv();
  await env.startWorker({ taskQueue: MAIN_TASK_QUEUE, activities: buildActivities(stubs) });
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

async function startSupervisor(workflowId: string, input: unknown) {
  const handle = await env.testEnv.client.workflow.start("roomAgentSupervisorWorkflow", {
    taskQueue: MAIN_TASK_QUEUE,
    workflowId,
    args: [input]
  });
  openHandles.push(handle);
  return handle;
}

describe("roomAgentSupervisorWorkflow carry bounds", () => {
  it("defers continueAsNew until the carried queue fits the next run's input bounds", async () => {
    const roomId = "room-sup-bound";
    const item = (index: number) =>
      supervisorQueueItem(roomId, "mission-bound", `bound-${String(index).padStart(3, "0")}`);
    const gate = makeGate();
    let gated = false;
    stubs.override("checkRoomAgentSupervisorTurn", async () => {
      if (!gated) {
        gated = true;
        await gate.promise;
      }
      return "SKIP";
    });

    const handle = await startSupervisor(
      "sup-test-bound",
      supervisorInput(roomId, { pending: [item(0)], processedCount: 49 })
    );
    await stubs.waitForCall("checkRoomAgentSupervisorTurn");
    for (let index = 1; index <= 105; index += 1) {
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(index));
    }
    const firstRunId = (await handle.describe()).runId;
    gate.open();
    await waitForRunIdChange(handle, firstRunId, 120000);
    // Initial item plus five extras drained so the carried pending list fits
    // the schema max of 100 (105 flooded + 1 initial - 6 drained = 100).
    expect(stubs.count("checkRoomAgentSupervisorTurn")).toBeGreaterThanOrEqual(6);
    expect(stubs.count("discardRoomAgentSupervisorTurn")).toBeGreaterThanOrEqual(6);

    await handle.cancel();
  }, 180000);
});
