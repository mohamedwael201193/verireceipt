// Explicit operator CLI, never imported by the server or run during build.
// node_modules/.bin/tsx scripts/inspect-visitor.ts [--job UUID]
// Optional hypothetical retention counts: --payload-days N --accounting-days N
import { Pool } from 'pg';
import { inspectVisitorJobs } from '../src/visitor/reconcile';
import { pgPoolConfig } from '../src/core/pgStore';
async function main(){
 const args=process.argv.slice(2),allowed=new Set(['--job','--payload-days','--accounting-days']);
 if(args.length%2||args.some((a,i)=>i%2===0&&!allowed.has(a)))throw new Error('Invalid arguments');
 const values=new Map<string,string>();for(let i=0;i<args.length;i+=2){if(values.has(args[i]))throw new Error('Duplicate argument');values.set(args[i],args[i+1]);}
 const payload=values.get('--payload-days'),accounting=values.get('--accounting-days');
 if(Boolean(payload)!==Boolean(accounting))throw new Error('Both explicit hypothetical periods required');
 if(!process.env.DATABASE_URL)throw new Error('Operator Postgres configuration required');
 const pool=new Pool({...pgPoolConfig(process.env.DATABASE_URL),max:1});
 try{const c=await pool.connect();try{const report=await inspectVisitorJobs(c,values.get('--job'),payload?{payloadDays:Number(payload),accountingDays:Number(accounting)}:undefined);process.stdout.write(JSON.stringify(report,null,2)+'\n');}finally{c.release();}}finally{await pool.end();}
}
void main().catch(()=>{console.error('Read-only visitor inspection failed. No purchase, refund, retry, erasure or lease change was performed. Check operator configuration and schema.');process.exitCode=1;});
