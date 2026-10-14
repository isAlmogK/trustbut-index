import { Command } from 'commander';
import { registerCollect } from './collect/command.js';
import { registerRun } from './run/command.js';

const program = new Command('trustbut-index').description('Agent test-honesty study pipeline');
// Each command module adds one register call here.
registerCollect(program);
registerRun(program);

await program.parseAsync(process.argv);
