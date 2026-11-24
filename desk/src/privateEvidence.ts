// Private append-only evidence with file and directory fsync. Refuse unsafe
// existing locations; never silently chmod another owner's/shared data.
import {constants,existsSync,lstatSync,realpathSync,mkdirSync,openSync,closeSync,fsyncSync,writeSync,fstatSync} from 'node:fs';
import {dirname,resolve,parse,join} from 'node:path';
export interface SyncIO {sync(fd:number):void;write(fd:number,data:string):void}
const native:SyncIO={sync:fsyncSync,write:(fd,data)=>{const b=Buffer.from(data);let p=0;while(p<b.length){const n=writeSync(fd,b,p,b.length-p);if(n<=0)throw new Error('short evidence write');p+=n;}}};
function canonical(path:string):string {
 if(!path.startsWith('/')||path!==resolve(path))throw new Error('private path must be absolute and canonical');
 const parts=path.slice(parse(path).root.length).split('/');let current=parse(path).root;
 for(const part of parts){current=join(current,part);try{if(lstatSync(current).isSymbolicLink())throw new Error('symlink in private evidence path');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 return path;
}
function ownedPrivate(path:string,directory:boolean){const s=lstatSync(path);if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile())||(s.mode&0o077)!==0||(process.getuid&&s.uid!==process.getuid()))throw new Error('evidence location must be owned, private and regular');}
export function syncDirectory(path:string,io:SyncIO=native):void {const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{io.sync(fd);}finally{closeSync(fd);}}
export function privateDirectory(path:string,io:SyncIO=native):void {
 canonical(path);
 if(!existsSync(path)){const parent=dirname(path);if(!existsSync(parent))throw new Error('private directory parent must already exist');mkdirSync(path,{mode:0o700});syncDirectory(parent,io);}
 ownedPrivate(path,true);if(realpathSync(path)!==path)throw new Error('noncanonical evidence directory');
}
export function privateFile(path:string,io:SyncIO=native):void {
 canonical(path);privateDirectory(dirname(path),io);
 if(!existsSync(path)){const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{io.sync(fd);}finally{closeSync(fd);}syncDirectory(dirname(path),io);}
 ownedPrivate(path,false);
}
export function durableWrite(path:string,data:string,append=false,io:SyncIO=native):void {
 canonical(path);privateDirectory(dirname(path),io);if(existsSync(path))ownedPrivate(path,false);
 const flags=constants.O_WRONLY|constants.O_NOFOLLOW|constants.O_CREAT|(append?constants.O_APPEND:constants.O_EXCL);
 const fd=openSync(path,flags,0o600);
 try{const s=fstatSync(fd);if(!s.isFile()||(s.mode&0o077)!==0||(process.getuid&&s.uid!==process.getuid()))throw new Error('unsafe opened evidence file');io.write(fd,data);io.sync(fd);}finally{closeSync(fd);}
 syncDirectory(dirname(path),io);
}
