/**
 * Shared harness for the real Temporal time-skipping tests (issue #60).
 *
 * Every test runs the REAL workflow code inside the workflow sandbox via
 * {@link TestWorkflowEnvironment.createTimeSkipping} with fully stubbed
 * activities. No network, database, Docker or AI provider is required.
 *
 * Workers are created with `workflowsPath` pointing at the test-only
 * all-workflows entry (which re-exports production sources). A
 * `webpackConfigHook` resolves `@space/*` workspace packages to their
 * TypeScript sources - the same aliases `vitest.config.ts` uses - so the
 * tests exercise the TypeScript sources directly.
 *
 * Pre-patch supervisor coverage uses Temporal's `patchActivationCallback`
 * so the production `roomAgentSupervisorWorkflow` takes the legacy branch
 * without copying workflow code.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment, type TestWorkflowEnvironmentOptions } from "@temporalio/testing";
import { Worker, type WorkerOptions } from "@temporalio/worker";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "../../../..");
const PACKAGES = resolve(ROOT, "packages");

export const MAIN_TASK_QUEUE = "temporal-sandbox-tests";
export const PRE_PATCH_TASK_QUEUE = "temporal-sandbox-tests-pre-patch";
export const MEMORY_MAINTENANCE_TASK_QUEUE = "space-memory-maintenance";
export const MEMORY_MUTATION_TASK_QUEUE = "space-memory-mutations";

/** Patch id that gates the continuing supervisor branch in production. */
export const ROOM_BACKGROUND_CONTINUATION_PATCH = "room-background-continuation-v1";

/** Resolves `@space/*` workspace packages to their TypeScript sources. */
const workflowBundleAliases: Record<string, string> = {
  "@space/contracts": resolve(PACKAGES, "contracts/src/index.ts"),
  "@space/db": resolve(PACKAGES, "db/src/index.ts"),
  "@space/runtime": resolve(PACKAGES, "runtime/src/index.ts"),
  "@space/streaming": resolve(PACKAGES, "streaming/src/index.ts")
};

/** The default workflowsPath: every production workflow (all 8 from issue #60). */
export function allWorkflowsPath(): string {
  return resolve(__dirname, "../support/all-workflows.ts");
}

export interface StartWorkerOptions {
  taskQueue: string;
  activities: Record<string, unknown>;
  /** Force selected patches off so production code takes a pre-patch branch. */
  disablePatches?: readonly string[];
  workflowsPath?: string;
}

export interface SandboxEnv {
  testEnv: TestWorkflowEnvironment;
  queues: Map<string, Worker>;
  startWorker(options: StartWorkerOptions): Promise<Worker>;
  teardown(): Promise<void>;
}

export async function createSandboxEnv(
  options: TestWorkflowEnvironmentOptions = {}
): Promise<SandboxEnv> {
  const testEnv = await TestWorkflowEnvironment.createTimeSkipping(options);
  const queues = new Map<string, Worker>();
  const runs: Promise<void>[] = [];

  const startWorker = async ({ taskQueue, activities, disablePatches, workflowsPath }: StartWorkerOptions) => {
    const existing = queues.get(taskQueue);
    if (existing) return existing;
    const disabled = new Set(disablePatches ?? []);
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.namespace,
      taskQueue,
      workflowsPath: workflowsPath ?? allWorkflowsPath(),
      activities: activities as WorkerOptions["activities"],
      maxConcurrentWorkflowTaskExecutions: 10,
      bundlerOptions: {
        webpackConfigHook: (config) => {
          config.resolve = config.resolve ?? {};
          config.resolve.alias = {
            ...(config.resolve.alias as Record<string, string> | undefined),
            ...workflowBundleAliases
          };
          return config;
        }
      },
      ...(disabled.size
        ? {
            // Temporal 1.24: PatchActivationCallback receives { workflowInfo, patchId }.
            patchActivationCallback: ({ patchId }: { patchId: string }) => !disabled.has(patchId)
          }
        : {})
    } as WorkerOptions);
    runs.push(worker.run());
    queues.set(taskQueue, worker);
    return worker;
  };

  const teardown = async () => {
    for (const worker of queues.values()) worker.shutdown();
    queues.clear();
    await Promise.allSettled(runs);
    await testEnv.teardown();
  };

  return { testEnv, queues, startWorker, teardown };
}

/** Bundles an entry for offline replay / negative determinism checks. */
export async function buildWorkflowBundle(entry: string): Promise<{ code: string; entry: string }> {
  const { bundleWorkflowCode } = await import("@temporalio/worker");
  const { code } = await bundleWorkflowCode({
    workflowsPath: entry,
    webpackConfigHook: (config) => {
      config.resolve = config.resolve ?? {};
      config.resolve.alias = {
        ...(config.resolve.alias as Record<string, string> | undefined),
        ...workflowBundleAliases
      };
      return config;
    }
  });
  return { code, entry };
}

/** Waits until predicate() is true, polling with a short interval. */
export async function waitFor(predicate: () => boolean, timeoutMs = 15000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Waits until the workflow handle points at a new run (continueAsNew). */
export async function waitForRunIdChange(
  handle: { describe(): Promise<{ runId: string }> },
  previousRunId: string,
  timeoutMs = 30000
): Promise<{ runId: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const description = await handle.describe();
    if (description.runId !== previousRunId) return description;
    if (Date.now() > deadline) throw new Error("Timed out waiting for continueAsNew");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
