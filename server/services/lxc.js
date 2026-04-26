import { insertLog } from "../db.js";

/**
 * LXC is intentionally mocked in v1 (hackathon demo). The server runs the
 * session command on the host with DISPLAY set; CRIU targets that process
 * on the host. A real LXC layer is a post-hackathon task.
 *
 * Post-hackathon real implementation (target behavior):
 * - Create:  lxc-create -n <name> -t none -B dir --dir <rootfs>
 * - Start:   lxc-start -n <name> -F -- <xpra-daemon-command>
 * - Stop:    lxc-stop -n <name> -k
 * - Destroy: lxc-destroy -n <name>
 * - Config:  lxc.conf with CRIU-compatible settings
 *
 * The mock below keeps a Map of container records so start/stop/destroy
 * and list() reflect a consistent fake lifecycle.
 */

/** @type {Map<string, { name: string, rootfs: string, createdAt: number, running: boolean, startedAt?: number, stoppedAt?: number }>} */
const mockContainers = new Map();

function recordFor(name) {
  const rootfs = `/tmp/gpms-mock-lxc/${name}/rootfs`;
  const createdAt = Date.now();
  return {
    name,
    rootfs,
    createdAt,
    running: false,
  };
}

/**
 * @param {string} name
 * @param {object} [_opts]
 * @returns {Promise<{ name: string, rootfs: string, createdAt: number }>}
 */
export async function createContainer(name, _opts = {}) {
  if (mockContainers.has(name)) {
    const existing = mockContainers.get(name);
    insertLog({
      level: "warn",
      message: `container ${name} already exists (mock, idempotent)`,
    });
    return {
      name: existing.name,
      rootfs: existing.rootfs,
      createdAt: existing.createdAt,
    };
  }
  const rec = recordFor(name);
  mockContainers.set(name, rec);
  insertLog({ level: "info", message: `container ${name} created (mock)` });
  return { name: rec.name, rootfs: rec.rootfs, createdAt: rec.createdAt };
}

/**
 * @param {string} name
 */
export async function startContainer(name) {
  let rec = mockContainers.get(name);
  if (!rec) {
    insertLog({
      level: "warn",
      message: `startContainer: unknown ${name} in mock, synthesizing record`,
    });
    rec = recordFor(name);
    mockContainers.set(name, rec);
  }
  rec.running = true;
  rec.startedAt = Date.now();
  delete rec.stoppedAt;
  insertLog({ level: "info", message: `container ${name} started (mock)` });
}

/**
 * @param {string} name
 */
export async function stopContainer(name) {
  const rec = mockContainers.get(name);
  if (rec) {
    rec.running = false;
    rec.stoppedAt = Date.now();
  }
  insertLog({ level: "info", message: `container ${name} stopped (mock)` });
}

/**
 * @param {string} name
 */
export async function destroyContainer(name) {
  mockContainers.delete(name);
  insertLog({ level: "info", message: `container ${name} destroyed (mock)` });
}

/**
 * Snapshot of mock-tracked containers (for debugging and tests).
 * @returns {Array<{ name: string, rootfs: string, createdAt: number, running: boolean, startedAt?: number, stoppedAt?: number }>}
 */
export function list() {
  return Array.from(mockContainers.values()).map((r) => ({ ...r }));
}
