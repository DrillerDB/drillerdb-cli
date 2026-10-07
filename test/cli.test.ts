import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { parseCommand, CliError } from '../src/commands.js';
import { redact, retryDelay, rateDelay, table } from '../src/client.js';

type Reply={status?:number;body?:unknown;headers?:Record<string,string>;raw?:string};
type Request={url:string;method:string;key:string|undefined;time:number};
async function cli(args:string[], env:Record<string,string>={}) {
  return await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,['dist/cli.js',...args],{env:{PATH:process.env.PATH,...env}});
    let stdout='',stderr=''; const timeout=setTimeout(()=>{child.kill();reject(new Error('CLI timed out'));},8000);
    child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    child.on('error',reject);child.on('close',code=>{clearTimeout(timeout);resolve({code,stdout,stderr});});
  });
}
async function mock(run:(base:string,requests:Request[])=>Promise<void>, reply:(req:IncomingMessage,n:number)=>Reply=()=>({body:{ok:true}})) {
  const requests:Request[]=[];
  const server=createServer((req,res)=>{
    requests.push({url:req.url!,method:req.method!,key:req.headers['x-api-key'] as string|undefined,time:performance.now()});
    const result=reply(req,requests.length);res.writeHead(result.status??200,{'Content-Type':'application/json',...result.headers});
    res.end(result.raw??JSON.stringify(result.body??{}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
  try {await run(`http://127.0.0.1:${port}`,requests);}
  finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
const fakeKey='ddb_test_SYNTHETIC_NOT_A_REAL_KEY';

test('geo zip executes a GET and emits one JSON document',async()=>{
  await mock(async(base,requests)=>{
    const result=await cli(['geo','zip','54401','--base-url',base]);
    expect(result).toEqual({code:0,stdout:'{\n  "latitude": 44.9,\n  "longitude": -89.6\n}\n',stderr:''});
    expect(requests.map(r=>[r.method,r.url,r.key])).toEqual([['GET','/api/geo/zip?zip=54401',undefined]]);
  },()=>({body:{latitude:44.9,longitude:-89.6}}));
});
const publicCases:[string[],string][]=[
  [['stats'],'/api/stats'],
  [['wells','depth','--lat','44.5236','--lng','-89.5746'],'/api/well-depth-lookup?lat=44.5236&lng=-89.5746'],
  [['drillers','license','--state','WI','--name','Well Drilling'],'/api/driller-license-lookup?state=WI&name=Well+Drilling'],
  [['drillers','license','--state','wisconsin','--license','1234'],'/api/driller-license-lookup?state=wisconsin&license=1234'],
  [['drillers','nearby','--zip','54401','--radius','25','--limit','5'],'/api/find-drillers/nearby?zip=54401&radius=25&limit=5'],
  [['drillers','nearby','--lat','44','--lng=-89'],'/api/find-drillers/nearby?lat=44&lng=-89'],
];
test.each(publicCases)('public route %j never sends the partner key',async(args,path)=>{
  await mock(async(base,requests)=>{
    expect((await cli([...args,'--api-key',fakeKey,'--base-url',base],{DRILLERDB_API_KEY:fakeKey})).code).toBe(0);
    expect(requests.map(r=>[r.method,r.url,r.key])).toEqual([['GET',path,undefined]]);
  });
});
const partnerCases:[string[],string][]=[
  [['projects','list'],'/projects'],[['projects','get','123'],'/projects/123'],[['projects','invoices','123'],'/projects/123/invoices'],
  [['work-orders','list'],'/work-orders'],[['work-orders','get','3'],'/work-orders/3'],
  [['contacts','list'],'/contacts'],[['contacts','get','4'],'/contacts/4'],
  [['equipment','list'],'/equipment'],[['equipment','get','rig 7'],'/equipment/rig%207'],
  [['inventory','list'],'/inventory/items'],[['inventory','get','5'],'/inventory/items/5'],
];
test.each(partnerCases)('partner route %j sends X-API-Key and preserves the base prefix',async(args,path)=>{
  await mock(async(base,requests)=>{
    const result=await cli([...args,'--base-url',base+'/api/partner/v1'],{DRILLERDB_API_KEY:fakeKey});
    expect(result.code).toBe(0);expect(requests.map(r=>[r.method,r.url,r.key])).toEqual([['GET','/api/partner/v1'+path,fakeKey]]);
  });
});
test('CLI key overrides env key and list filters use the published query names',async()=>{
  await mock(async(base,requests)=>{
    const result=await cli(['contacts','list','--api-key',fakeKey,'--limit','2','--cursor','opaque+cursor','--updated-since','2026-10-01T00:00:00Z'],{DRILLERDB_API_KEY:'fake_ENV_KEY',DRILLERDB_BASE_URL:base});
    expect(result.code).toBe(0);expect(requests[0].key).toBe(fakeKey);
    expect(requests[0].url).toBe('/contacts?limit=2&cursor=opaque%2Bcursor&updated_since=2026-10-01T00%3A00%3A00Z');
  });
});
test('all follows cursors and emits one aggregated envelope',async()=>{
  await mock(async(base,requests)=>{
    const result=await cli(['projects','list','--limit','1','--all','--base-url',base,'--api-key',fakeKey]);
    expect(result.code).toBe(0);const body=JSON.parse(result.stdout);
    expect(body.data).toEqual([{id:1},{id:2},{id:3}]);expect(body.meta).toMatchObject({pages:3,count:3,next_cursor:null,has_more:false});
    expect(body.links.next).toBeNull();expect(requests.map(r=>r.url)).toEqual(['/projects?limit=1','/projects?limit=1&cursor=c2','/projects?limit=1&cursor=c3']);
  },(_,n)=>({body:{data:[{id:n}],meta:{next_cursor:n<3?`c${n+1}`:null,has_more:n<3},links:{next:n<3?'next':null}}}));
});
test.each(['loop','missing','invalid','non-array'])('all rejects %s pagination without partial output',async(kind)=>{
  await mock(async(base,requests)=>{
    const result=await cli(['inventory','list','--all','--base-url',base,'--api-key',fakeKey]);
    expect(result.code).toBe(1);expect(result.stdout).toBe('');expect(result.stderr).toContain('INVALID_RESPONSE');expect(requests.length).toBeLessThanOrEqual(2);
  },()=>({body:{data:kind==='non-array'?{}:[],meta:{next_cursor:kind==='loop'?'repeat':kind==='invalid'?9:null,has_more:true}}}));
});
test('429 honors Retry-After before GET retry',async()=>{
  await mock(async(base,requests)=>{
    const result=await cli(['stats','--base-url',base]);expect(result.code).toBe(0);expect(requests).toHaveLength(2);
    expect(requests[1].time-requests[0].time).toBeGreaterThanOrEqual(45);
  },(_,n)=>n===1?{status:429,headers:{'Retry-After':'0.05'},body:{error:{code:'RATE_LIMITED',message:'Wait'}}}:{body:{ok:true}});
});
test('429 retries are bounded to two retries',async()=>{
  await mock(async(base,requests)=>{
    const result=await cli(['stats','--base-url',base]);expect(result.code).toBe(4);expect(result.stdout).toBe('');expect(requests).toHaveLength(3);
  },()=>({status:429,headers:{'Retry-After':'0'},body:{error:{code:'RATE_LIMITED',message:'Wait'}}}));
});
test.each([['--no-retry','0'],['long-delay','86400']])('429 %s makes only one request',async(flag,delay)=>{
  await mock(async(base,requests)=>{
    const result=await cli(['stats','--base-url',base,...(flag==='--no-retry'?[flag]:[])]);
    expect(result.code).toBe(4);expect(requests).toHaveLength(1);
  },()=>({status:429,headers:{'Retry-After':delay},body:{error:{code:'RATE_LIMITED',message:'Wait'}}}));
});
test('all slows down on a low RateLimit remaining value',async()=>{
  await mock(async(base,requests)=>{
    const result=await cli(['contacts','list','--all','--base-url',base,'--api-key',fakeKey]);
    expect(result.code).toBe(0);expect(requests).toHaveLength(2);expect(requests[1].time-requests[0].time).toBeGreaterThanOrEqual(950);
  },(_,n)=>({headers:{RateLimit:'"minute";r=0;t=1'},body:{data:[],meta:{next_cursor:n===1?'next':null}}}));
});
test.each([400,401,403,404,500,503])('HTTP %i preserves error details and does not retry',async(status)=>{
  await mock(async(base,requests)=>{
    const result=await cli(['projects','get','1','--base-url',base,'--api-key',fakeKey]);
    expect(result.code).toBe(1);expect(result.stdout).toBe('');expect(requests).toHaveLength(1);
    expect(result.stderr).toBe('EXAMPLE_ERROR: Failure\nHint: Help\nrequest_id: mock-request\n');
  },()=>({status,body:{error:{code:'EXAMPLE_ERROR',message:'Failure',hint:'Help'},meta:{request_id:'mock-request'}}}));
});
test('key masking covers success JSON, table and API errors including encoded keys',async()=>{
  await mock(async base=>{
    for(const format of ['json','table']) {
      const result=await cli(['projects','get','1','--format',format,'--base-url',base,'--api-key',fakeKey]);
      expect(result.code).toBe(0);expect(result.stdout).not.toContain(fakeKey);expect(result.stdout).toContain('[REDACTED]');
      if(format==='json')JSON.parse(result.stdout);
    }
  },()=>({body:{data:{echo:fakeKey}}}));
  await mock(async base=>{
    const result=await cli(['projects','get','1','--base-url',base,'--api-key',fakeKey]);
    expect(result.code).toBe(1);expect(result.stderr).not.toContain(fakeKey);expect(result.stderr).toContain('request_id:');
  },()=>({status:401,body:{error:{code:fakeKey,message:fakeKey,hint:fakeKey},meta:{request_id:fakeKey}}}));
  expect(redact('abc/key%2Fsecret12',['key/secret12'])).not.toContain('key%2Fsecret12');
});
test('redirect is refused and key is not forwarded',async()=>{
  await mock(async(base,requests)=>{
    const result=await cli(['projects','list','--base-url',base,'--api-key',fakeKey]);
    expect(result.code).toBe(1);expect(requests).toHaveLength(1);
  },()=>({status:302,headers:{Location:'/collect-keys'}}));
});
test('network failure is exit 3 and never echoes a key',async()=>{
  const result=await cli(['projects','list','--base-url','http://127.0.0.1:1','--api-key',fakeKey]);
  expect(result.code).toBe(3);expect(result.stdout).toBe('');expect(result.stderr).toBe('NETWORK_ERROR: Request failed or timed out\n');
});
test.each([200,404])('non-JSON HTTP %i response is API error',async(status)=>{
  await mock(async base=>{const result=await cli(['stats','--base-url',base]);expect(result.code).toBe(1);expect(result.stdout).toBe('');},()=>({status,raw:'<html>Not JSON</html>'}));
});
const badArgs=[
  ['projects','list'],['stats','unexpected'],['unknown'],['stats','--all'],['stats','--limit','2'],['stats','--bogus',fakeKey],
  ['wells','depth','--lat','0','--lng','0'],['wells','depth','--lat','NaN','--lng','-89'],['geo','zip','1234'],
  ['drillers','license','--state','WI','--name','a'],['drillers','license','--state','WI','--name','ab','--license','12'],
  ['drillers','nearby','--zip','54401','--lat','44','--lng','-89'],['drillers','nearby','--lat','44'],
  ['work-orders','list','--updated-since','2026-01-01T00:00:00Z','--api-key',fakeKey],
  ['projects','invoices','1','--updated-since','2026-01-01T00:00:00Z','--api-key',fakeKey],
  ['projects','list','--limit','201','--api-key',fakeKey],['projects','get','-1','--api-key',fakeKey],
  ['equipment','get','../steal','--api-key',fakeKey],['stats','--format','csv'],['stats','--format','json','--format','table'],
  ['stats','--base-url','http://example.com'],['stats','--base-url','https://user:password@example.com'],
];
test.each(badArgs.map(args=>[args]))('usage %j exits 2 before network',async args=>{
  const result=await cli(args);expect(result.code).toBe(2);expect(result.stdout).toBe('');expect(result.stderr).not.toContain(fakeKey);
});
test('help succeeds; OpenAPI URL and document are keyless',async()=>{
  expect((await cli(['--help'])).code).toBe(0);
  expect(JSON.parse((await cli(['openapi'])).stdout)).toBe('https://drillerdb.com/openapi.json');
  expect(JSON.parse((await cli(['openapi','--partner'])).stdout)).toBe('https://console.drillerdb.com/api/partner/v1/openapi.json');
  await mock(async(base,requests)=>{
    const result=await cli(['openapi','--partner','--document','--api-key',fakeKey,'--base-url',base]);
    expect(result.code).toBe(0);expect(JSON.parse(result.stdout)).toEqual({openapi:'3.1.0'});expect(requests[0].key).toBeUndefined();
  },()=>({body:{openapi:'3.1.0'}}));
});
test('table prints field names, nested values and empty lists',()=>{
  expect(table({data:[{id:1,address:{city:'Wausau'}}]})).toContain('{"city":"Wausau"}');
  expect(table({data:[]})).toBe('(no rows)\n');
});
test('Retry-After accepts seconds and dates; RateLimit examines every policy',()=>{
  expect(retryDelay('2')).toBe(2000);expect(retryDelay('Thu, 01 Jan 1970 00:00:02 GMT',1000)).toBe(1000);
  expect(retryDelay('garbage')).toBe(1000);expect(retryDelay(null)).toBe(1000);
  expect(rateDelay('"minute";r=5;t=12, "day";r=0;t=100')).toBe(100000);expect(rateDelay(null)).toBe(0);
});
test('default partner/public hosts and string equipment IDs match the contract',()=>{
  const partner=parseCommand(['equipment','get','rig-A'],{DRILLERDB_API_KEY:fakeKey});
  expect(partner).not.toBe('help');if(partner==='help')throw new Error('not a command');
  expect(partner.url.href).toBe('https://console.drillerdb.com/api/partner/v1/equipment/rig-A');
  expect(()=>parseCommand(['stats','--base-url','https://example.com?key=hidden'],{})).toThrow(CliError);
});
test('keyed commands send the key only to drillerdb.com hosts unless --allow-custom-host',()=>{
  const refused=(args:string[],env:Record<string,string>)=>{
    try {parseCommand(args,env);} catch(error) {
      expect(error).toBeInstanceOf(CliError);expect((error as CliError).exitCode).toBe(2);
      expect((error as CliError).message).not.toContain(fakeKey);return (error as CliError).message;
    }
    throw new Error(`accepted ${args.join(' ')}`);
  };
  for(const base of ['https://attacker.example.net/x','https://evildrillerdb.com','https://drillerdb.com.evil.example','https://drillerdb.com.'])
    expect(refused(['projects','list','--api-key',fakeKey,'--base-url',base],{})).toContain('--allow-custom-host');
  expect(refused(['contacts','get','4'],{DRILLERDB_API_KEY:fakeKey,DRILLERDB_BASE_URL:'https://attacker.example.net'})).toContain('attacker.example.net');
  for(const base of ['https://drillerdb.com','https://app.drillerdb.com/api/v1','https://console.drillerdb.com/api/partner/v1','http://127.0.0.1:9']) {
    const command=parseCommand(['projects','list','--base-url',base],{DRILLERDB_API_KEY:fakeKey});
    if(command==='help')throw new Error('not a command');expect(command.key).toBe(fakeKey);
  }
  const custom=parseCommand(['projects','list','--base-url','https://attacker.example.net','--allow-custom-host'],{DRILLERDB_API_KEY:fakeKey});
  if(custom==='help')throw new Error('not a command');expect(custom.url.hostname).toBe('attacker.example.net');
  const keyless=parseCommand(['stats','--base-url','https://example.org'],{DRILLERDB_API_KEY:fakeKey});
  if(keyless==='help')throw new Error('not a command');expect(keyless.key).toBeUndefined();
});
test('a refused custom host makes no request and prints no key',async()=>{
  const result=await cli(['projects','list'],{DRILLERDB_API_KEY:fakeKey,DRILLERDB_BASE_URL:'https://attacker.example.net'});
  expect(result.code).toBe(2);expect(result.stdout).toBe('');
  expect(result.stderr).toContain('--allow-custom-host');expect(result.stderr).not.toContain(fakeKey);
});
test('table output removes terminal control and bidi override characters',()=>{
  const out=table({data:[{'na\x1b]0;x\x07me':'a\x1b[2Jb\u202ec\x9bd\u2066e'}]});
  expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
  expect(out).toContain('a [2Jb c d e');
});
