import {
  SOLANA_PAYMENT_CONFIRMED,
  SOLANA_PAYMENT_REQUEST,
} from "../../solana/socket-events.js";

export const S = {
  sessionCreated: "session:created",
  sessionList: "session:list",
  sessionUpdated: "session:updated",
  sessionHung: "session:hung",
  sessionEnded: "session:ended",
  migrationStarted: "migration:started",
  migrationProgress: "migration:progress",
  migrationTransferProgress: "migration:transfer-progress",
  migrationStep: "migration:step",
  migrationCompleted: "migration:completed",
  migrationFailed: "migration:failed",
  solanaPaymentRequest: SOLANA_PAYMENT_REQUEST,
  solanaPaymentConfirmed: SOLANA_PAYMENT_CONFIRMED,
  machineList: "machine:list",
  machineUpdated: "machine:updated",
  logEntry: "log:entry",
  sessionLaunch: "session:launch",
  sessionMigrate: "session:migrate",
  sessionKill: "session:kill",
  sessionCheckpoint: "session:checkpoint",
};
