// Offline/local operator control. Never loads a runtime, key or signer; no network.
// Usage: node scripts/arm-buyer.cjs status|close|arm DATABASE PAYER [PLAN_ID PLAN_HASH EXPIRES_ISO]
const fs=require('node:fs');const path=require('node:path');
const {BuyerStore}=require('../dist/buyer/store');
const [command,file,payer,id,hash,expiry]=process.argv.slice(2);
if(!['status','close','arm'].includes(command)||!file||!payer||!path.isAbsolute(file)||!fs.existsSync(file))throw new Error('Use an existing absolute authority path and exact canonical payer');
const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||fs.realpathSync(file)!==file||(stat.mode&0o077)!==0)throw new Error('Authority must be canonical private regular file');
const store=new BuyerStore(file,payer);
try{if(command==='arm')store.armOneShot(id,hash,Date.parse(expiry),'10000');else if(command==='close')store.closePurchases();console.log(JSON.stringify(store.oneShotStatus()));}finally{store.close();}
