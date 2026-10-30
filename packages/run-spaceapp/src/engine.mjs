// Rootless Podman support for the run-spaceapp launcher (issue #63).
//
// Supported combination: Podman 5 or newer, with `podman compose` backed by
// the docker-compose v2 provider (Compose spec major version 2 or newer).
// The Python podman-compose provider is not supported: it does not implement
// the Compose features this stack uses (profiles, file secrets, depends_on
// health conditions with required: false, init, resource limits, and --wait).
//
// The published images start as root and drop to uid 10001 with gosu. Under
// rootless Podman that only works when the container's initial user is root
// inside the user namespace. `userns_mode: keep-id:uid=10001,gid=10001` maps
// the host user to container uid 10001, which is what makes files the agent
// writes on a bind mount belong to the host user. Without an explicit
// `user: "0:0"` the same keep-id mode starts the entrypoint as uid 10001,
// and gosu then fails with "operation not permitted". The Podman overlay
// therefore sets both. Backup and restore run as 10001:10001 on Podman so
// the files they write into ./backups are owned by the host user; container
// uid 0 is a subordinate id in this mapping and would leave those files
// unreadable by the host user.

import { UNIVERSAL_COMMAND } from "./package-info.mjs";

export const MIN_PODMAN_MAJOR = 5;
export const MIN_COMPOSE_MAJOR = 2;
export const PODMAN_KEEP_ID = "keep-id:uid=10001,gid=10001";
export const PODMAN_APP_USER = "10001:10001";
export const PODMAN_SERVICES = Object.freeze([
  "spaceapp-core",
  "spaceapp-cli",
  "spaceapp-browser",
  "codex-sessions-init"
]);

export function configEngine(config) {
  return config?.engine === "podman" ? "podman" : "docker";
}

export function assertContainerEngine(engine) {
  if (engine !== "docker" && engine !== "podman") {
    throw new Error('Container engine must be "docker" or "podman".');
  }
  return engine;
}

export function engineSwitchMessage(existingEngine, requestedEngine) {
  return (
    `This SpaceApp installation uses the ${existingEngine} engine. ` +
    `Switching it to ${requestedEngine} in place is refused because ${existingEngine} volumes are not visible to ${requestedEngine}. ` +
    `Migrate with a portable backup instead: run "${UNIVERSAL_COMMAND} backup", ` +
    `then "${UNIVERSAL_COMMAND} uninstall --purge-data", ` +
    `then "${UNIVERSAL_COMMAND} install --engine ${requestedEngine}", ` +
    `then "${UNIVERSAL_COMMAND} restore".`
  );
}

export function hostRootOnPodmanMessage() {
  return (
    "Host-root access is refused on Podman. It bind-mounts the host root into the container, " +
    "which is not supported for the rootless Podman user namespace. " +
    `Install with Docker for --access host-root, or rerun with --access isolated.`
  );
}

export function parseVersionTriplet(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: `${match[1]}.${match[2]}.${match[3]}`
  };
}

export function parsePodmanVersion(text) {
  const match = /podman version\s+(\d+\.\d+\.\d+)/i.exec(String(text ?? ""));
  return parseVersionTriplet(match?.[1] ?? "");
}

export function podmanVersionSupported(text) {
  const parsed = parsePodmanVersion(text);
  return Boolean(parsed && parsed.major >= MIN_PODMAN_MAJOR);
}

// `podman compose version` prints the provider, for example
// "Docker Compose version v2.39.4". A podman-compose 1.x line is rejected.
export function composeProviderSupported(text) {
  const source = String(text ?? "");
  if (/podman-compose/i.test(source) && !/docker compose/i.test(source)) {
    return false;
  }
  const parsed = parseVersionTriplet(source);
  return Boolean(parsed && parsed.major >= MIN_COMPOSE_MAJOR);
}

export function engineImageId(value) {
  const text = String(value ?? "").trim();
  if (/^sha256:[a-f0-9]{64}$/.test(text)) return text;
  // Podman image inspect prints a bare 64-character id when the format is {{.Id}}.
  if (/^[a-f0-9]{64}$/.test(text)) return `sha256:${text}`;
  return null;
}

export function normalizeEngineInfo(engine, parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (engine === "podman") {
    const host = parsed.host ?? {};
    const controllers = Array.isArray(host.cgroupControllers) ? host.cgroupControllers.map(String) : [];
    return {
      engine: "podman",
      version: typeof parsed.version?.Version === "string" ? parsed.version.Version : null,
      rootless: host.security?.rootless === true,
      cgroupVersion: typeof host.cgroupVersion === "string" ? host.cgroupVersion : null,
      controllers,
      architecture: typeof host.arch === "string" ? host.arch : "",
      cpuCount: Number(host.cpus) || 0,
      memoryBytes: Number(host.memTotal) || 0,
      graphRoot: typeof parsed.store?.graphRoot === "string" ? parsed.store.graphRoot : null
    };
  }
  const controllers = Array.isArray(parsed.CgroupControllers) ? parsed.CgroupControllers.map(String) : [];
  return {
    engine: "docker",
    version: typeof parsed.ServerVersion === "string" ? parsed.ServerVersion : null,
    rootless: parsed.Rootless === true || (Array.isArray(parsed.SecurityOptions) && parsed.SecurityOptions.some((item) => /rootless/i.test(String(item)))),
    cgroupVersion: typeof parsed.CgroupVersion === "string" ? parsed.CgroupVersion : null,
    controllers,
    architecture: typeof parsed.Architecture === "string" ? parsed.Architecture : "",
    cpuCount: Number(parsed.NCPU) || 0,
    memoryBytes: Number(parsed.MemTotal) || 0,
    graphRoot: typeof parsed.DockerRootDir === "string" ? parsed.DockerRootDir : null
  };
}

export function engineArchitecture(facts) {
  return /arm|aarch64/i.test(facts?.architecture ?? "") ? "arm64" : "amd64";
}

function controllerPresent(facts, name) {
  return (facts?.controllers ?? []).some((controller) => controller === name);
}

// Linux rootless Podman must be rootless, on cgroup v2, with the cpu and
// memory controllers delegated. A missing controller is reported here, before
// `up`, because Podman would otherwise reject or silently drop mem_limit and
// cpus while the stack is already half started.
export function engineRuntimeChecks(facts, { platform = "linux" } = {}) {
  if (!facts || facts.engine !== "podman") return [];
  const version = facts.version ?? "unknown";
  const mode = facts.rootless ? "rootless" : "rootful";
  const requireLinuxRuntime = platform === "linux";
  const controllersKnown = (facts.controllers ?? []).length > 0;
  const cpu = controllerPresent(facts, "cpu");
  const memory = controllerPresent(facts, "memory");
  const cpuDetail = cpu
    ? "cpu controller is delegated; cpus limits can be applied"
    : "cpu controller is not delegated, so SpaceApp's cpus limits cannot be applied. " +
      "On systemd, set Delegate=cpu cpuset io memory pids for user@.service, then restart the user session.";
  const memoryDetail = memory
    ? "memory controller is delegated; mem_limit can be applied"
    : "memory controller is not delegated, so SpaceApp's mem_limit values cannot be applied. " +
      "On systemd, set Delegate=cpu cpuset io memory pids for user@.service, then restart the user session.";
  return [
    {
      name: "Podman mode",
      ok: !requireLinuxRuntime || facts.rootless === true,
      detail: `${mode}, Podman ${version}`
    },
    {
      name: "Podman cgroup",
      ok: !requireLinuxRuntime || facts.cgroupVersion === "v2",
      detail: facts.cgroupVersion === "v2"
        ? "cgroup v2"
        : `${facts.cgroupVersion ?? "unknown cgroup version"}; rootless Podman needs cgroup v2 to apply CPU and memory limits`
    },
    {
      name: "Podman CPU limits",
      ok: !requireLinuxRuntime || (controllersKnown && cpu),
      detail: controllersKnown
        ? cpuDetail
        : requireLinuxRuntime
          ? "cgroup controllers were not reported, so SpaceApp cannot confirm that cpus limits will be applied"
          : "cgroup controllers were not reported; CPU limits are unchecked"
    },
    {
      name: "Podman memory limits",
      ok: !requireLinuxRuntime || (controllersKnown && memory),
      detail: controllersKnown
        ? memoryDetail
        : requireLinuxRuntime
          ? "cgroup controllers were not reported, so SpaceApp cannot confirm that mem_limit will be applied"
          : "cgroup controllers were not reported; memory limits are unchecked"
    }
  ];
}

export function supportBundleEngineFacts(facts, { platform = "linux" } = {}) {
  if (!facts) return null;
  const checks = engineRuntimeChecks(facts, { platform });
  return {
    engine: facts.engine,
    version: facts.version,
    mode: facts.rootless ? "rootless" : "rootful",
    cgroupVersion: facts.cgroupVersion,
    controllers: [...(facts.controllers ?? [])],
    cpuLimitsDelegated: controllerPresent(facts, "cpu"),
    memoryLimitsDelegated: controllerPresent(facts, "memory"),
    checks: checks.map((check) => ({ name: check.name, ok: check.ok, detail: check.detail }))
  };
}

function machineRecord(parsed) {
  if (Array.isArray(parsed)) return parsed[0] ?? null;
  return parsed && typeof parsed === "object" ? parsed : null;
}

// Podman 5 nests machine sizing under Resources: CPUs is a count, Memory is
// MiB, DiskSize is GiB. Older output used top-level fields in bytes.
export function podmanMachineAssessment(raw, requirements) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {
      ok: false,
      reason: "podman-machine-inspect-failed",
      issues: ["podman machine inspect returned invalid JSON. Is the machine running?"]
    };
  }
  const machine = machineRecord(parsed);
  if (!machine) {
    return {
      ok: false,
      reason: "podman-machine-inspect-failed",
      issues: ["podman machine inspect did not return a machine. Start one with: podman machine start"]
    };
  }
  const state = typeof machine.State === "string" ? machine.State.toLowerCase() : "";
  if (machine.Running === false || (state && state !== "running")) {
    return {
      ok: false,
      reason: "podman-machine-not-running",
      issues: ["The Podman machine is not running. Start it with: podman machine start"]
    };
  }
  const resources = machine.Resources ?? {};
  const cpus = Number(resources.CPUs ?? machine.CPUs ?? 0);
  const memoryBytes = resources.Memory !== undefined
    ? Number(resources.Memory) * 1024 ** 2
    : Number(machine.Memory) || 0;
  const diskBytes = resources.DiskSize !== undefined
    ? Number(resources.DiskSize) * 1024 ** 3
    : Number(machine.DiskSize) || 0;
  const issues = [];
  if (requirements?.cpuCount && cpus > 0 && cpus < requirements.cpuCount) {
    issues.push(
      `Podman machine CPUs: ${cpus} (profile needs ${requirements.cpuCount}). ` +
      `Resize with: podman machine stop && podman machine set --cpus ${requirements.cpuCount} && podman machine start`
    );
  }
  if (requirements?.memoryBytes && memoryBytes > 0 && memoryBytes < requirements.memoryBytes) {
    const memoryMib = Math.ceil(requirements.memoryBytes / (1024 ** 2));
    issues.push(
      `Podman machine memory: ${formatBytes(memoryBytes)} (profile needs ${formatBytes(requirements.memoryBytes)}). ` +
      `Resize with: podman machine stop && podman machine set --memory ${memoryMib} && podman machine start`
    );
  }
  if (requirements?.freshDiskBytes && diskBytes > 0 && diskBytes < requirements.freshDiskBytes) {
    const diskGib = Math.ceil(requirements.freshDiskBytes / (1024 ** 3));
    issues.push(
      `Podman machine disk: ${formatBytes(diskBytes)} (profile needs ${formatBytes(requirements.freshDiskBytes)}). ` +
      `Disk can grow but not shrink: podman machine stop && podman machine set --disk-size ${diskGib} && podman machine start`
    );
  }
  return { ok: issues.length === 0, reason: issues.length === 0 ? "ok" : "podman-machine-undersized", issues };
}

export function podmanInstallHelp(platform = "linux") {
  const docs = "https://podman.io/docs/installation";
  if (platform === "darwin") {
    return [
      "Podman is not ready on this Mac.",
      "Install Podman 5 or newer, then start a machine with enough CPU, memory, and disk for the profile:",
      "  brew install podman",
      "  podman machine init --cpus 4 --memory 7168 --disk-size 20",
      "  podman machine start",
      "  podman compose version",
      `The compose provider must be docker-compose v2 (https://github.com/docker/compose/releases), not podman-compose.`,
      `Documentation: ${docs}`
    ].join("\n");
  }
  if (platform === "win32") {
    return "Podman is not supported on Windows by this launcher. Use --engine docker.";
  }
  return [
    "Podman is not ready for SpaceApp.",
    "Install Podman 5 or newer and the docker-compose v2 provider (podman-compose is not supported):",
    "  Debian/Ubuntu: sudo apt-get install podman",
    "  Fedora/RHEL: sudo dnf install podman",
    "  docker-compose v2: https://github.com/docker/compose/releases",
    "Rootless Podman also needs cgroup v2 and delegated cpu and memory controllers, and `podman info` must succeed as your user.",
    `Verify with: podman --version && podman compose version && podman info`,
    `Documentation: ${docs}`
  ].join("\n");
}

export function podmanApiServiceHelp() {
  return [
    "The Podman API socket is not reachable, so docker-compose cannot connect.",
    "The launcher starts `podman system service` when the socket is missing.",
    "On systemd you can also run: systemctl --user enable --now podman.socket",
    "On macOS, start the machine: podman machine start"
  ].join("\n");
}

export function renderPodmanRuntimeCompose() {
  const lines = ["services:"];
  for (const name of PODMAN_SERVICES) {
    lines.push(
      `  ${name}:`,
      `    user: "0:0"`,
      `    userns_mode: ${JSON.stringify(PODMAN_KEEP_ID)}`
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function selinuxBindLines() {
  return ["        bind:", '          selinux: "z"'];
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Math.round(value * 10) / 10} ${units[unit]}`;
}
