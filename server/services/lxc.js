import { insertLog } from "../db.js";

/**
 * LXC is mocked for the demo — no real lxc-* calls.
 */
export async function createContainer(name, _opts = {}) {
  insertLog({ level: "info", message: `container ${name} created (mock)` });
  return { name, rootfs: `/tmp/gpms-mock-lxc/${name}/rootfs` };
}

export async function startContainer(name) {
  insertLog({ level: "info", message: `container ${name} started (mock)` });
}

export async function stopContainer(name) {
  insertLog({ level: "info", message: `container ${name} stopped (mock)` });
}

export async function destroyContainer(name) {
  insertLog({ level: "info", message: `container ${name} destroyed (mock)` });
}
