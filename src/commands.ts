import { parseArgs } from 'node:util';

export class CliError extends Error {
  constructor(message: string, readonly exitCode: number) { super(message); }
}
export const PUBLIC_BASE = 'https://drillerdb.com';
export const PARTNER_BASE = 'https://console.drillerdb.com/api/partner/v1';
// The only hosts that serve the partner API: the console API and the classic app API.
export const KEY_HOSTS = ['console.drillerdb.com', 'app.drillerdb.com'];
export const HELP = `drillerdb - read-only DrillerDB API CLI

Public commands (no key):
  wells depth --lat <18..72> --lng <-178..-66>
  drillers license --state <state> (--name <name> | --license <number>)
  drillers nearby (--zip <zip> | --lat <lat> --lng <lng>) [--radius <miles>] [--limit <1..250>]
  geo zip <zip>
  stats
Partner commands (DRILLERDB_API_KEY or --api-key):
  projects list | get <intWellKey> | invoices <intWellKey>
  work-orders list | get <id>
  contacts list | get <rolodexId>
  equipment list | get <equipmentId>
  inventory list | get <id>
  List options: --limit <1..200> --cursor <cursor> --all
  --updated-since <ISO timestamp>: projects, contacts, equipment, inventory lists only
Documentation:
  openapi [--partner] [--document]
Global options:
  --base-url <url> (DRILLERDB_BASE_URL), --format json|table, --no-retry, --help
  --allow-custom-host: send the API key to a host other than console.drillerdb.com
  or app.drillerdb.com (prints a warning)
JSON is the default. All network requests are GETs. Exit codes: 0 success,
1 API/protocol error, 2 usage, 3 network, 4 rate limited, 5 internal error.
`;
const strings = ['lat','lng','state','name','license','zip','radius','limit','cursor','updated-since','api-key','base-url','format'];
const booleans = ['all','partner','document','no-retry','help','allow-custom-host'];
const globalOptions = ['api-key','base-url','format','no-retry','help','allow-custom-host'];
type Values = Record<string, string | boolean | undefined>;
export interface Command {
  url: URL; key?: string; format: 'json'|'table'; all: boolean; retry: boolean; specUrlOnly: boolean; warning?: string;
}
const INTERNAL = 'INTERNAL_ERROR: Unexpected CLI failure; please report it';
/** Maps any thrown value to the stderr text and exit code; unknown failures never echo their message. */
export function failure(error: unknown): {message: string; exitCode: number} {
  return error instanceof CliError ? {message: error.message, exitCode: error.exitCode} : {message: INTERNAL, exitCode: 5};
}
function usage(message: string): never { throw new CliError(message, 2); }
function required(v: Values, name: string): string {
  const value = v[name];
  if (typeof value !== 'string' || !value.trim()) usage(`Missing --${name}`);
  return value;
}
function number(v: Values, name: string, min: number, max: number, integer = false): string {
  const value = required(v, name); const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
    usage(`--${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  return String(n);
}
function zip(value: string | undefined): string {
  if (!value || !/^\d{5}$/.test(value)) usage('ZIP must contain five digits');
  return value;
}
function id(value: string | undefined, stringId: boolean): string {
  if (!value || (!stringId && !/^[1-9]\d*$/.test(value))) usage('A positive integer ID is required');
  if (value === '.' || value === '..' || /[\/\\\x00-\x1f]/.test(value)) usage('Invalid ID');
  return encodeURIComponent(value);
}
export function parseCommand(args: string[], env: NodeJS.ProcessEnv): Command | 'help' {
  // Node 18 parseArgs considers a separate negative value an ambiguous option.
  const normalized: string[] = [];
  for (let i=0;i<args.length;i++) {
    if (['--lat','--lng'].includes(args[i]) && /^-\d/.test(args[i+1] ?? ''))
      normalized.push(`${args[i]}=${args[++i]}`);
    else normalized.push(args[i]);
  }
  let v: Values, p: string[];
  try {
    const options: Record<string, {type:'string'|'boolean'}> = {};
    for (const name of strings) options[name]={type:'string'};
    for (const name of booleans) options[name]={type:'boolean'};
    const parsed = parseArgs({args:normalized, options, allowPositionals:true, strict:true, tokens:true});
    const seen=new Set<string>();
    for (const token of parsed.tokens) if (token.kind==='option') {
      if (seen.has(token.name)) usage(`Repeated --${token.name}`); seen.add(token.name);
    }
    v=parsed.values; p=parsed.positionals;
  } catch (error) { if (error instanceof CliError) throw error; usage('Invalid options; run drillerdb --help'); }
  if (v.help || args.length===0) return 'help';
  let route='', partner=false, allowed: string[]=[], all=false, specUrlOnly=false;
  const query=new URLSearchParams();
  const add=(name:string,value:string)=>query.set(name,value);
  const exact=(count:number)=>{if(p.length!==count) usage('Unexpected or missing arguments; run drillerdb --help');};
  if (p[0]==='wells' && p[1]==='depth') {
    exact(2); route='/api/well-depth-lookup'; allowed=['lat','lng'];
    add('lat',number(v,'lat',18,72)); add('lng',number(v,'lng',-178,-66));
  } else if (p[0]==='drillers' && p[1]==='license') {
    exact(2); route='/api/driller-license-lookup'; allowed=['state','name','license'];
    const state=required(v,'state'); if(state.length<2) usage('--state requires at least two characters'); add('state',state);
    if (!!v.name === !!v.license) usage('Provide exactly one of --name or --license');
    const field=v.name?'name':'license', value=required(v,field);
    if(value.length<2) usage(`--${field} requires at least two characters`); add(field,value);
  } else if (p[0]==='drillers' && p[1]==='nearby') {
    exact(2); route='/api/find-drillers/nearby'; allowed=['zip','lat','lng','radius','limit'];
    if(v.zip) { if(v.lat!==undefined || v.lng!==undefined) usage('Choose ZIP or coordinates'); add('zip',zip(required(v,'zip'))); }
    else { add('lat',number(v,'lat',-90,90)); add('lng',number(v,'lng',-180,180)); }
    if(v.radius!==undefined) add('radius',number(v,'radius',0.01,150));
    if(v.limit!==undefined) add('limit',number(v,'limit',1,250,true));
  } else if(p[0]==='geo' && p[1]==='zip') {
    exact(3);route='/api/geo/zip';add('zip',zip(p[2]));
  } else if(p[0]==='stats') {exact(1);route='/api/stats';}
  else if(p[0]==='openapi') {
    exact(1);partner=!!v.partner;route='/openapi.json';allowed=['partner','document'];specUrlOnly=!v.document;
  } else if(['projects','work-orders','contacts','equipment','inventory'].includes(p[0])) {
    partner=true;const resource=p[0], action=p[1], base=resource==='inventory'?'/inventory/items':`/${resource}`;
    if(action==='get') {exact(3);route=`${base}/${id(p[2],resource==='equipment')}`;}
    else if(action==='list' || (resource==='projects' && action==='invoices')) {
      exact(action==='invoices'?3:2);route=action==='invoices'?`${base}/${id(p[2],false)}/invoices`:base;
      allowed=['limit','cursor','all']; all=!!v.all;
      if(action==='list' && resource!=='work-orders') allowed.push('updated-since');
      if(v.limit!==undefined) add('limit',number(v,'limit',1,200,true));
      if(v.cursor!==undefined) add('cursor',required(v,'cursor'));
      if(v['updated-since']!==undefined && allowed.includes('updated-since')) {
        const value=required(v,'updated-since');
        if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
          usage('--updated-since requires an ISO timestamp with timezone');
        add('updated_since',value);
      }
    } else usage('Unknown resource command; run drillerdb --help');
  } else usage('Unknown command; run drillerdb --help');
  for(const name of Object.keys(v)) if(![...globalOptions,...allowed].includes(name)) usage(`--${name} is not supported for this command`);
  const format=v.format??'json'; if(format!=='json' && format!=='table') usage('--format must be json or table');
  let base:URL;
  try {base=new URL(String(v['base-url']??env.DRILLERDB_BASE_URL??(partner?PARTNER_BASE:PUBLIC_BASE)));}
  catch {usage('Invalid base URL');}
  if(base.username || base.password || base.search || base.hash) usage('Base URL must not contain credentials, query or fragment');
  const loopback=['localhost','127.0.0.1','[::1]'].includes(base.hostname);
  if(base.protocol!=='https:' && !(base.protocol==='http:' && loopback))
    usage('Base URL requires HTTPS (HTTP is allowed only on loopback for testing)');
  const url=new URL(base.toString());url.pathname=base.pathname.replace(/\/$/,'')+route;url.search=query.toString();
  const key=partner && p[0]!=='openapi'?String(v['api-key']??env.DRILLERDB_API_KEY??''):undefined;
  if(partner && p[0]!=='openapi' && !key) usage('Partner commands require DRILLERDB_API_KEY or --api-key');
  // Redaction masks the key everywhere in output, so a very short key would blank ordinary text.
  if(key!==undefined && key.length<8) usage('The API key must have at least 8 characters');
  // A base URL from a poisoned environment must not receive the key.
  let warning: string|undefined;
  if(key!==undefined && !loopback && !KEY_HOSTS.includes(base.hostname)) {
    if(!v['allow-custom-host'])
      usage(`Refusing to send the API key to ${base.hostname}: keyed commands call ${KEY_HOSTS.join(' or ')} only. Pass --allow-custom-host to override.`);
    warning=`Warning: sending the API key to ${base.hostname} because --allow-custom-host is set.`;
  }
  return {url,key,format,all,retry:!v['no-retry'],specUrlOnly,warning};
}
