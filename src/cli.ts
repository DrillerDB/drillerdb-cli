#!/usr/bin/env node
import { HELP, failure, parseCommand } from './commands.js';
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
    if(command.warning) process.stderr.write(redact(command.warning+'\n',keys));
    const result=await read(command);
    const output=command.format==='table'?table(result):JSON.stringify(result,null,2)+'\n';
    process.stdout.write(redact(output,keys));
  }
} catch(error) {
  const {message,exitCode}=failure(error);
  process.stderr.write(redact(message+'\n',keys));
  process.exitCode=exitCode;
}
