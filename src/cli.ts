// Thin entry point. bin/faktory execs this file, and herdr process detection
// (src/herdr/bootstrap.ts) matches "cli.ts" in the command line, so the entry
// must stay here. The command layer lives under src/cli/.
import { main } from "./cli/index.ts";

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
