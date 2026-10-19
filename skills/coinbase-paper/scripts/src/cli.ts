// Entry point for the standalone Coinbase paper trading simulator (coinbase-paper).
// Local accounting with virtual funds; reads only public Coinbase market data; never places live orders.
import { runPaper } from './commands/paper.ts';

export const VERSION = '0.1.0';

const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === '-V') {
  process.stdout.write(`coinbase-paper ${VERSION}\n`);
} else {
  process.exitCode = await runPaper(args);
}
