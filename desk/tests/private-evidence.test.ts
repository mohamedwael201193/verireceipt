import {it,expect,describe,afterEach} from 'vitest';
import {mkdtempSync,rmSync,statSync,symlinkSync,mkdirSync,writeFileSync,readFileSync,fsyncSync,writeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {privateDirectory,privateFile,durableWrite} from '../src/privateEvidence.js';
const dirs:string[]=[];const root=()=>{const d=mkdtempSync(join(tmpdir(),'private-evidence-unit-'));dirs.push(d);return d;};afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{force:true,recursive:true});});
describe('private evidence filesystem boundaries',()=>{
 it('uses 0700 directories and 0600 files under umask 022',()=>{const r=root(),old=process.umask(0o022);try{const d=join(r,'evidence');privateDirectory(d);durableWrite(join(d,'one'),'unit');expect(statSync(d).mode&0o777).toBe(0o700);expect(statSync(join(d,'one')).mode&0o777).toBe(0o600);}finally{process.umask(old);}});
 it('refuses a public existing evidence directory',()=>{const r=root(),d=join(r,'evidence');mkdirSync(d,{mode:0o755});expect(()=>privateDirectory(d)).toThrow('private');});
 it('refuses a public existing ledger',()=>{const r=root(),f=join(r,'ledger');writeFileSync(f,'',{mode:0o644});expect(()=>privateFile(f)).toThrow('private');});
 it('refuses symlink leaf and symlink ancestor',()=>{const r=root(),target=join(r,'real');privateDirectory(target);symlinkSync(target,join(r,'link'));expect(()=>privateDirectory(join(r,'link'))).toThrow();expect(()=>privateDirectory(join(r,'link','nested'))).toThrow();writeFileSync(join(target,'real'),'',{mode:0o600});symlinkSync(join(target,'real'),join(target,'fake'));expect(()=>durableWrite(join(target,'fake'),'bad',true)).toThrow();});
 it('refuses relative and noncanonical paths',()=>{expect(()=>privateDirectory('relative')).toThrow();expect(()=>privateDirectory(root()+'/x/../bad')).toThrow();});
 it('syncs file then parent directory for append',()=>{const r=root(),path=join(r,'ledger');privateFile(path);let syncs=0;durableWrite(path,'unit\n',true,{write:(fd,data)=>{writeSync(fd,data);},sync:fd=>{syncs++;fsyncSync(fd);}});expect(syncs).toBe(2);expect(readFileSync(path,'utf8')).toBe('unit\n');});
 it('surfaces write failure',()=>{const r=root();expect(()=>durableWrite(join(r,'one'),'unit',false,{write:()=>{throw new Error('UNIT write fail');},sync:fsyncSync})).toThrow('write fail');});
 it.each([1,2])('surfaces sync failure at stage %s',stage=>{const r=root();let n=0;expect(()=>durableWrite(join(r,'one'),'unit',false,{write:(fd,data)=>{writeSync(fd,data);},sync:fd=>{if(++n===stage)throw Error('UNIT sync fail');fsyncSync(fd);}})).toThrow('sync fail');});
});
