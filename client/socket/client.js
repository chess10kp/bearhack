import { io } from "socket.io-client";
import { config } from "../config.js";

/** @type {import('socket.io-client').Socket | null} */
let socket = null;

const MAX_QUEUE = 5000;
/** @type {Array<{ event: string, data: any }>} */
const queue = [];

/**
 * @param {string} serverUrl
 * @param {{ path?: string }} [opts]
 */
export function connect(serverUrl, opts = {}) {
  const u = (serverUrl || config.SERVER_URL).replace(/\/$/, "");
  const path = opts.path || "/socket.io";
  if (socket?.connected) return socket;
  socket = io(`${u}/client`, {
    path,
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    reconnectionAttempts: Infinity,
  });
  socket.on("connect", () => {
    while (queue.length) {
      const item = queue.shift();
      if (item) {
        try {
          socket?.emit(item.event, item.data);
        } catch {
          queue.unshift(item);
          break;
        }
      }
    }
  });
  return socket;
}

export function getConnection() {
  return socket;
}

export function isConnected() {
  return Boolean(socket?.connected);
}

/**
 * @param {string} event
 * @param {any} [data]
 */
export function emit(event, data) {
  if (socket?.connected) {
    try {
      socket.emit(event, data);
    } catch {
      enqueue(event, data);
    }
  } else {
    enqueue(event, data);
  }
}

/**
 * @param {string} event
 * @param {any} [data]
 */
function enqueue(event, data) {
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push({ event, data });
}

export function flushQueue() {
  if (!socket?.connected) return;
  while (queue.length) {
    const item = queue.shift();
    if (item) socket.emit(item.event, item.data);
  }
}

/**
 * @param {() => void} [fn]
 */
export function onDisconnectLog(fn) {
  socket?.on("disconnect", () => {
    if (fn) fn();
  });
}
