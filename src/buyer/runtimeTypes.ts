import type {BuyerPlan} from './contracts';
import type {SigningCheckpoint} from './store';
export interface BuyerExecutionOptions {
 signal:AbortSignal;scratchRoot:string;
 beforeSign:(checkpoint:SigningCheckpoint)=>Promise<void>;
 recordHeaders:(r:{status:number;receipt_header:string|null})=>Promise<void>;
 recordBody:(r:{status:number;receipt_header:string|null;body_text:string})=>Promise<void>;
}
export interface BuyerExecutionResult {
 version:'hosted-ranked-filing-result-v1';plan_hash:string;policy_hash:string;task_hash:string;plan_id:string;payer:string;
 charge:{status:'not_signed'|'receipt'|'uncertain';amount_uusdc:string|null;maximum_uusdc:string};
 record:Record<string,unknown>;receipt:Record<string,unknown>|null;
 limits:string[];
}
export interface BuyerRuntime {
 cleanup:(root:string)=>void;
 assertConfiguration:()=>{payer:string;scratchRoot:string};
 makePlan:(input:unknown)=>BuyerPlan;
 execute:(plan:BuyerPlan,options:BuyerExecutionOptions)=>Promise<BuyerExecutionResult>;
 followup:(plan:BuyerPlan,result:BuyerExecutionResult,signal:AbortSignal)=>Promise<unknown>;
}
