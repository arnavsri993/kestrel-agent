import { parseCliArguments } from "./arguments";
import { runAcpStdio } from "./acp-stdio";

const command = parseCliArguments(["acp", ...process.argv.slice(2)]);
if (command.name !== "acp") throw new Error("Invalid ACP command.");
runAcpStdio(command).catch((error) => {
  process.stderr.write(`kestrel-acp: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
