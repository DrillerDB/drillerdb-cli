#!/usr/bin/env node
import { CliError, HELP, parseCommand } from './commands.js';
import { read, redact, table } from './client.js';

const args=process.argv.slice(2);
const keys=[process.env.DRILLERDB_API_KEY??''];
for(let i=0;i<args.length;i++) {
  if(args[i]==='--api-key') keys.push(args[i+1]??'');
  if(args[i].startsWith('--api-key=')) keys.push(args[i].slice('--api-key='.length));
}
try {
  const command=parseCommand(args,process.env);
  if(command==='help') process.stdout.write(HELP);
  else {
    const result=await read(command);
    const output=command.format==='table'?table(result):JSON.stringify(result,null,2)+'\n';
    process.stdout.write(redact(output,keys));
  }
} catch(error) {
  const known=error instanceof CliError;
  process.stderr.write(redact((known?error.message:'NETWORK_ERROR: Unexpected request failure')+'\n',keys));
  process.exitCode=known?error.exitCode:3;
}
