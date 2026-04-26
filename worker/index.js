#!/usr/bin/env node
import { Command } from "commander";
import { runDaemon } from "./daemon.js";
import { config } from "./config.js";

const program = new Command();
program
  .name("gpms-worker")
  .description("GPMS remote worker daemon")
  .version("0.1.0");

program
  .command("start")
  .description("Start worker HTTP daemon")
  .action(async () => {
    await runDaemon();
    process.stdout.write(
      `gpms-worker listening on http://${config.host}:${config.port}\n`,
    );
  });

program.parseAsync().catch((err) => {
  process.stderr.write(`${err?.message || err}\n`);
  process.exit(1);
});
