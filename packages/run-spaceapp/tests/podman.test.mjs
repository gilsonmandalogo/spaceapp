import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import {
  composeProviderSupported,
  engineImageId,
  engineRuntimeChecks,
  engineSwitchMessage,
  normalizeEngineInfo,
  parsePodmanVersion,
  podmanMachineAssessment,
  renderPodmanRuntimeCompose
} from "../src/engine.mjs";
import {
  applyPodmanHostMounts,
  composeCommand,
  createDefaultConfig,
  initializeInstallation,
  prepareInstallation,
  renderWorkspaceCompose,
  saveConfig,
  validateConfig
} from "../src/index.mjs";

const launcherManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const RUNTIME_VERSION = launcherManifest.spaceappRuntimeVersion;
const home = join(tmpdir(), "spaceapp-podman-command");

function capture() {
  let value = "";
  return {
    stream: new Writable({ write(chunk, _encoding, done) { value += chunk.toString(); done(); } }),
    value: () => value
  };
}

const resources = Object.freeze({
  cpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
  freeDiskBytes: 40 * 1024 ** 3
});

const podmanInfo = {
  version: { Version: "5.8.8" },
  host: {
    arch: "amd64",
    cpus: 8,
    memTotal: 16 * 1024 ** 3,
    security: { rootless: true },
    cgroupVersion: "v2",
    cgroupControllers: ["cpu", "cpuset", "memory", "pids"]
  },
  store: { graphRoot: "/home/ubuntu/.local/share/containers/storage" }
};

function podmanExecute(calls) {
  return async (spec, io) => {
    calls.push(spec);
    if (spec.command === "podman" && spec.args[0] === "--version") {
      io?.stdout?.write("podman version 5.8.8\n");
      return 0;
    }
    if (spec.command === "podman" && spec.args[0] === "compose" && spec.args[1] === "version") {
      io?.stdout?.write("Docker Compose version v2.39.4\n");
      return 0;
    }
    if (spec.command === "podman" && spec.args[0] === "info") {
      io?.stdout?.write(JSON.stringify(podmanInfo));
      return 0;
    }
    if (spec.command === "podman" && spec.args[0] === "compose" && spec.args[1] === "ls") return 0;
    if (spec.command === "docker") return 127;
    return 0;
  };
}

test("docker compose commands stay unchanged and podman adds the overlay", () => {
  const docker = composeCommand("up", home, { profile: "small" });
  assert.equal(docker.command, "docker");
  assert.equal(docker.args.includes(join(home, "compose.podman.yml")), false);
  const podman = composeCommand("up", home, { profile: "small", engine: "podman" });
  assert.equal(podman.command, "podman");
  assert.ok(podman.args.includes(join(home, "compose.podman.yml")));
  assert.deepEqual(podman.args.slice(-3), ["up", "-d", "--remove-orphans"]);
  assert.ok(podman.args.includes("--wait") === false);
  const checkpoint = composeCommand("ensureCheckpointDatabase", home, { profile: "small", engine: "podman" });
  assert.ok(checkpoint.args.includes("--wait"));
  const backup = composeCommand("backup", home, { profile: "small", engine: "podman" });
  assert.equal(backup.args[backup.args.indexOf("--user") + 1], "10001:10001");
  assert.equal(backup.args[backup.args.indexOf("--no-deps") + 1], "-T");
  const dockerBackup = composeCommand("backup", home, { profile: "small" });
  assert.equal(dockerBackup.args[dockerBackup.args.indexOf("--user") + 1], "0:0");
  const restore = composeCommand("restore", home, { profile: "small", engine: "podman", backupId: "spaceapp-backup-20261030T010203004Z" });
  assert.equal(restore.args[restore.args.indexOf("--user") + 1], "0:0");
  const exec = composeCommand("rotateOwnerSetupToken", home, { engine: "podman" });
  assert.equal(exec.args[exec.args.indexOf("--user") + 1], "10001:10001");
});

test("podman overlay starts published images as root inside keep-id", () => {
  const overlay = renderPodmanRuntimeCompose();
  for (const service of ["spaceapp-core", "spaceapp-cli", "spaceapp-browser", "codex-sessions-init"]) {
    assert.match(overlay, new RegExp(`${service}:\\n    user: "0:0"\\n    userns_mode: "keep-id:uid=10001,gid=10001"`));
  }
  assert.doesNotMatch(overlay, /postgres|temporal/);
});

test("workspace binds gain a shared SELinux label only for podman", () => {
  const config = {
    ...createDefaultConfig({ version: "1.1.9", profile: "small" }),
    workspaces: [{
      id: "project-a1b2c3d4",
      name: "project",
      hostPath: "/home/alice/project",
      containerPath: "/workspaces/project",
      readOnly: false
    }]
  };
  const docker = renderWorkspaceCompose(config);
  assert.doesNotMatch(docker, /selinux/);
  const podman = renderWorkspaceCompose({ ...config, engine: "podman" }, { cliSandbox: true });
  assert.match(podman, /selinux: "z"/);
  assert.doesNotMatch(podman, /seccomp=/);
  const users = renderWorkspaceCompose({
    ...config,
    engine: "podman",
    users: [{ id: "user:Ab12", workspaces: config.workspaces }]
  });
  assert.match(users, /user: "0:0"/);
  assert.match(users, /keep-id:uid=10001,gid=10001/);
  assert.match(users, /secrets\/users\/ab12-[a-f0-9]{6}\/providers/);
  assert.match(users, /selinux: "z"/);
  const dockerUsers = renderWorkspaceCompose({ ...config, users: [{ id: "user:Ab12", workspaces: [] }] });
  assert.match(dockerUsers, /secrets\/users\/ab12-[a-f0-9]{6}\/providers:\/run\/spaceapp-secrets\/providers:ro/);
  assert.doesNotMatch(dockerUsers, /selinux/);
});

test("podman rewrites host binds and refuses an engine switch or host-root", async () => {
  const template = await readFile(new URL("../templates/compose.yml", import.meta.url), "utf8");
  const rewritten = applyPodmanHostMounts(template);
  assert.match(rewritten, /source: "\.\/backups"/);
  assert.match(rewritten, /source: "\.\/secrets\/providers"/);
  assert.match(rewritten, /selinux: "z"/);
  assert.equal(template.includes("      - ./backups:/backups"), true);
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-config-"));
  const fresh = await prepareInstallation(root, { version: RUNTIME_VERSION, profile: "small", engine: "podman" });
  assert.equal(fresh.config.engine, "podman");
  await saveConfig(root, fresh.config);
  const dockerRoot = await mkdtemp(join(tmpdir(), "spaceapp-docker-config-"));
  const dockerFresh = await prepareInstallation(dockerRoot, { version: RUNTIME_VERSION, profile: "small", engine: "docker" });
  assert.equal(dockerFresh.config.engine, undefined);
  await saveConfig(dockerRoot, dockerFresh.config);
  await assert.rejects(
    () => prepareInstallation(root, { version: RUNTIME_VERSION, profile: "small", engine: "docker" }),
    new RegExp(engineSwitchMessage("podman", "docker").slice(0, 40))
  );
  await assert.rejects(
    () => prepareInstallation(dockerRoot, { version: RUNTIME_VERSION, profile: "small", accessMode: "isolated", engine: "podman" }),
    /not visible/
  );
  await assert.rejects(
    async () => validateConfig({ ...fresh.config, accessMode: "host-root" }),
    /Host-root access is refused on Podman/
  );
});

test("engine facts accept podman info, bare image ids, and machine sizing", () => {
  assert.deepEqual(parsePodmanVersion("podman version 5.8.8\n"), { major: 5, minor: 8, patch: 8, raw: "5.8.8" });
  assert.equal(parsePodmanVersion("podman version 4.9.3").major < 5, true);
  assert.equal(composeProviderSupported("Docker Compose version v2.39.4"), true);
  assert.equal(composeProviderSupported("podman-compose version 1.0.6"), false);
  assert.equal(engineImageId("sha256:" + "a".repeat(64)), "sha256:" + "a".repeat(64));
  assert.equal(engineImageId("b".repeat(64)), "sha256:" + "b".repeat(64));
  assert.equal(engineImageId("short"), null);
  const facts = normalizeEngineInfo("podman", podmanInfo);
  assert.equal(facts.rootless, true);
  assert.equal(facts.graphRoot, podmanInfo.store.graphRoot);
  assert.equal(engineRuntimeChecks(facts, { platform: "linux" }).every((check) => check.ok), true);
  const rootful = engineRuntimeChecks({ ...facts, rootless: false }, { platform: "linux" });
  assert.equal(rootful.find((check) => check.name === "Podman mode").ok, false);
  const missingCpu = engineRuntimeChecks({ ...facts, controllers: ["memory"] }, { platform: "linux" });
  assert.equal(missingCpu.find((check) => check.name === "Podman CPU limits").ok, false);
  const unknown = engineRuntimeChecks({ ...facts, controllers: [] }, { platform: "linux" });
  assert.equal(unknown.find((check) => check.name === "Podman CPU limits").ok, false);
  assert.equal(engineRuntimeChecks({ ...facts, controllers: [] }, { platform: "darwin" }).find((check) => check.name === "Podman CPU limits").ok, true);
  const machine = podmanMachineAssessment([{
    State: "running",
    Running: true,
    Resources: { CPUs: 2, Memory: 2048, DiskSize: 5 }
  }], { cpuCount: 4, memoryBytes: 7 * 1024 ** 3, freshDiskBytes: 6.5 * 1024 ** 3 });
  assert.equal(machine.ok, false);
  assert.match(machine.issues.join("\n"), /podman machine set --cpus 4/);
  assert.match(machine.issues.join("\n"), /--memory /);
  assert.match(machine.issues.join("\n"), /--disk-size /);
});

test("install --engine podman builds podman compose commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-install-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const code = await run([
    "install", "--engine", "podman", "--profile", "small", "--access", "isolated", "--no-open",
    "--non-interactive",
    "--answers", JSON.stringify({ confirm: true, profile: "small", access: "isolated", companions: false, telemetry: false, open: false })
  ], {
    env: { SPACEAPP_HOME: root, PATH: "/usr/bin:/bin" },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: capture().stream,
    inspectResources: async () => resources,
    prepareDockerPath: async () => null,
    request: async (url) => ({
      ok: true,
      status: 200,
      json: async () => String(url).endsWith("/readyz") ? { ok: true } : { setupRequired: false, expiresAt: null }
    }),
    sleep: async () => {},
    execute: podmanExecute(calls)
  });
  assert.equal(code, 0, stderr.value());
  assert.equal(calls.some((spec) => spec.command === "docker" && spec.args?.includes("pull")), false);
  assert.equal(calls.some((spec) => spec.command === "podman" && spec.args?.includes("pull")), true);
  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(config.engine, "podman");
  const overlay = await readFile(join(root, "compose.podman.yml"), "utf8");
  assert.match(overlay, /keep-id:uid=10001,gid=10001/);
  assert.match(await readFile(join(root, "compose.yml"), "utf8"), /selinux: "z"/);
  assert.match(stdout.value(), /persistent Podman volumes/);
  assert.doesNotMatch(stdout.value(), /persistent Docker volumes/);
  assert.match(stdout.value(), /Podman: use the Podman already installed/);
});

test("host-root and engine switches are refused before images are pulled", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-refuse-"));
  const stderr = capture();
  const calls = [];
  assert.equal(await run([
    "install", "--engine", "podman", "--access", "host-root", "--no-open",
    "--non-interactive", "--answers", JSON.stringify({ confirm: true })
  ], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: stderr.stream,
    inspectResources: async () => resources,
    execute: podmanExecute(calls)
  }), 1);
  assert.match(stderr.value(), /Host-root access is refused on Podman/);
  assert.equal(calls.some((spec) => spec.args?.includes("pull")), false);

  await initializeInstallation(root, { version: RUNTIME_VERSION, profile: "small" });
  const switched = capture();
  assert.equal(await run([
    "install", "--engine", "podman", "--no-open",
    "--non-interactive", "--answers", JSON.stringify({ confirm: true })
  ], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: switched.stream,
    inspectResources: async () => resources,
    execute: podmanExecute(calls)
  }), 1);
  assert.match(switched.value(), /uninstall --purge-data/);
  assert.match(switched.value(), /not visible/);
});

test("podman backup resumes paused containers with podman unpause", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-backup-"));
  await initializeInstallation(root, { version: RUNTIME_VERSION, profile: "small", engine: "podman" });
  const calls = [];
  const code = await run(["backup"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: capture().stream,
    prepareDockerPath: async () => null,
    execute: async (spec, io) => {
      calls.push(spec);
      if (spec.command === "podman" && spec.args[0] === "ps" && spec.args.includes("status=paused")) {
        io.stdout.write("abc123\n");
      }
      return 0;
    }
  });
  assert.equal(code, 0);
  const unpause = calls.find((spec) => spec.command === "podman" && spec.args[0] === "unpause");
  assert.deepEqual(unpause?.args, ["unpause", "abc123"]);
  const listed = calls.find((spec) => spec.command === "podman" && spec.args[0] === "ps");
  assert.ok(listed.args.includes("status=paused"));
  assert.ok(listed.args.some((arg) => arg.startsWith("label=com.docker.compose.project=spaceapp-")));
  assert.equal(calls.some((spec) => spec.command === "podman" && spec.args.includes("pause")), true);
});

test("podman down unpauses containers before compose down", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-down-"));
  await initializeInstallation(root, { version: RUNTIME_VERSION, profile: "small", engine: "podman" });
  const calls = [];
  const code = await run(["down"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: capture().stream,
    prepareDockerPath: async () => null,
    execute: async (spec, io) => {
      calls.push(spec.args);
      if (spec.args.includes("status=paused")) io.stdout.write("abc123\n");
      return 0;
    }
  });
  assert.equal(code, 0);
  const pauseList = calls.findIndex((args) => args.includes("status=paused"));
  const unpause = calls.findIndex((args) => args[0] === "unpause");
  const down = calls.findIndex((args) => args.at(-1) === "down");
  assert.ok(pauseList !== -1 && unpause === pauseList + 1 && down === unpause + 1);
});

test("doctor reports rootless podman, cgroup v2, and delegated limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-doctor-"));
  await initializeInstallation(root, { version: RUNTIME_VERSION, profile: "small", engine: "podman" });
  const stdout = capture();
  const stderr = capture();
  const code = await run(["doctor"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: capture().stream,
    inspectResources: async () => resources,
    prepareDockerPath: async () => null,
    execute: podmanExecute([])
  });
  assert.equal(code, 0, stderr.value());
  assert.match(stdout.value(), /PASS Podman CLI: Podman 5\.8\.8/);
  assert.match(stdout.value(), /PASS Podman Compose: docker-compose v2/);
  assert.match(stdout.value(), /rootless, cgroup v2/);
  assert.match(stdout.value(), /cpu controller is delegated/);
  assert.match(stdout.value(), /memory controller is delegated/);
  assert.doesNotMatch(stdout.value(), /PASS Docker CLI/);
});
