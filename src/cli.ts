#!/usr/bin/env node
import { HELP, failure, parseCommand } from './commands.js';
import { read, redact, safeJson, table } from './client.js';

const args=process.argv.slice(2);
const keys=[process.env.DRILLERDB_API_KEY??''];
for(let i=0;i<args.length;i++) {
  if(args[i]==='--api-key') keys.push(args[i+1]??'');
  if(args[i].startsWith('--api-key=')) keys.push(args[i].slice('--api-key='.length));
}
// Keys under 8 characters are refused before any request, so masking them would only garble the refusal text.
const masked=keys.filter(key=>key.length>=8);
try {
  const command=parseCommand(args,process.env);
  if(command==='help') process.stdout.write(HELP);
  else {
    if(command.warning) process.stderr.write(redact(command.warning+'\n',masked));
    const result=await read(command);
    const output=command.format==='table'?table(result):safeJson(result)+'\n';
    process.stdout.write(redact(output,masked));
  }
} catch(error) {
  const {message,exitCode}=failure(error);
  process.stderr.write(redact(message+'\n',masked));
  process.exitCode=exitCode;
}
