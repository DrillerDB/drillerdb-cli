import { CliError, type Command } from './commands.js';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value && typeof value==='object' && !Array.isArray(value)?value as ObjectValue:{};
}
export function redact(text: string, keys: string[]): string {
  for(const key of keys.filter(Boolean).sort((a,b)=>b.length-a.length)) {
    const mask=key.length>8 && /^[A-Za-z0-9_-]{4}/.test(key)?`${key.slice(0,4)}[REDACTED]`:'[REDACTED]';
    for(const form of new Set([key,encodeURIComponent(key),JSON.stringify(key).slice(1,-1)]))
      text=text.split(form).join(mask);
  }
  return text;
}
export function retryDelay(header: string|null, now=Date.now()): number {
  if(header===null) return 1000;
  if(/^\d+(?:\.\d+)?$/.test(header.trim())) return Math.ceil(Number(header)*1000);
  const date=Date.parse(header);return Number.isFinite(date)?Math.max(0,date-now):1000;
}
export function rateDelay(header: string|null): number {
  let delay=0;
  for(const policy of (header??'').split(',')) {
    const remaining=/(?:^|;)\s*r=(\d+)/.exec(policy), reset=/(?:^|;)\s*t=(\d+)/.exec(policy);
    if(remaining && reset && Number(remaining[1])<=5)
      delay=Math.max(delay,Math.ceil(Number(reset[1])*1000/(Number(remaining[1])+1)));
  }
  return delay;
}
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function apiError(status:number, payload:unknown):CliError {
  const body=object(payload), error=object(body.error), meta=object(body.meta);
  const code=error.code??`HTTP_${status}`, message=error.message??(typeof body.error==='string'?body.error:`API returned HTTP ${status}`);
  const hint=error.hint??body.hint, requestId=meta.request_id;
  return new CliError(`${code}: ${message}${hint?`\nHint: ${hint}`:''}${requestId?`\nrequest_id: ${requestId}`:''}`, status===429?4:1);
}
async function get(command:Command):Promise<{payload:unknown;rate:string|null}> {
  for(let attempt=0; ; attempt++) {
    let response:Response, payload:unknown;
    try {
      response=await fetch(command.url,{method:'GET',headers:command.key?{'X-API-Key':command.key}:{},redirect:'manual',signal:AbortSignal.timeout(20_000)});
      const text=await response.text();
      try {payload=JSON.parse(text);}
      catch {payload={error:{code:`HTTP_${response.status}`,message:'API returned a non-JSON response'}};if(response.ok) throw new CliError('INVALID_RESPONSE: API returned a non-JSON response',1);}
    } catch(error) {
      if(error instanceof CliError) throw error;
      // Fetch errors can contain a URL, headers or a supplied credential.
      throw new CliError('NETWORK_ERROR: Request failed or timed out',3);
    }
    if(response.status===429 && command.retry && attempt<2) {
      const delay=retryDelay(response.headers.get('retry-after'));
      if(delay<=30_000) {await sleep(delay);continue;}
      const error=apiError(429,payload);
      throw new CliError(`${error.message}\nHint: Retry-After exceeds the 30-second automatic wait budget; retry later.`,4);
    }
    if(!response.ok) throw apiError(response.status,payload);
    return {payload,rate:response.headers.get('ratelimit')};
  }
}
export async function read(command:Command):Promise<unknown> {
  if(command.specUrlOnly) return command.url.toString();
  const first=await get(command);
  if(!command.all) return first.payload;
  const body=object(first.payload), initial=body.data;
  if(!Array.isArray(initial)) throw new CliError('INVALID_RESPONSE: Expected list data for --all',1);
  const data=[...initial];let page=first;let pages=1;
  const seen=new Set<string>();const initialCursor=command.url.searchParams.get('cursor');if(initialCursor)seen.add(initialCursor);
  while(true) {
    const meta=object(object(page.payload).meta), cursor=meta.next_cursor;
    if(cursor===null || cursor===undefined || cursor==='') {
      if(meta.has_more===true) throw new CliError('INVALID_RESPONSE: Missing cursor with has_more=true',1);
      break;
    }
    if(typeof cursor!=='string' || seen.has(cursor) || pages>=1000) throw new CliError('INVALID_RESPONSE: Repeated/invalid cursor or 1000-page limit reached',1);
    seen.add(cursor);
    const delay=rateDelay(page.rate);
    if(delay>30_000) throw new CliError('RATE_LIMITED: Pagination wait exceeds 30 seconds; retry later with a smaller page size',4);
    if(delay>0) await sleep(delay);
    command.url.searchParams.set('cursor',cursor);
    page=await get(command);pages++;
    const next=object(page.payload).data;
    if(!Array.isArray(next))throw new CliError('INVALID_RESPONSE: Expected list data for --all',1);
    data.push(...next);
  }
  // A single document; preserve first-page links and last-page meta, identify aggregation.
  return {...body,data,meta:{...object(object(page.payload).meta),pages,count:data.length,next_cursor:null,has_more:false},links:{...object(body.links),next:null}};
}
export function table(payload:unknown):string {
  const data=object(payload).data??payload;
  const rows=Array.isArray(data)?data:[data];
  if(rows.length===0)return '(no rows)\n';
  const records:ObjectValue[]=rows.map(value=>value && typeof value==='object' && !Array.isArray(value)?value as ObjectValue:{value});
  const columns=[...new Set(records.flatMap(row=>Object.keys(row)))];
  const cell=(v:unknown)=>v===null || v===undefined?'':typeof v==='object'?JSON.stringify(v):String(v);
  // API strings may carry terminal control or bidi override characters that rewrite the display.
  const printable=(s:string)=>s.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,' ');
  const matrix=[columns.map(printable),...records.map(row=>columns.map(col=>printable(cell(row[col]))))];
  const widths=columns.map((_,i)=>matrix.reduce((width,row)=>Math.max(width,row[i].length),0));
  return matrix.map(row=>row.map((s,i)=>s.padEnd(widths[i])).join('  ').trimEnd()).join('\n')+'\n';
}
