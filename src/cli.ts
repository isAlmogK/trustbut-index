import { Command } from 'commander';
import { registerCollect } from './collect/command.js';

const program = new Command('trustbut-index').description('Agent test-honesty study pipeline');
// Each command module adds one register call here.
registerCollect(program);

await program.parseAsync(process.argv);
