import { Command } from 'commander';

const program = new Command('trustbut-index').description('Agent test-honesty study pipeline');
// Each command module adds one register call here.

await program.parseAsync(process.argv);
