import {afterEach,it,expect,vi} from "vitest";
import {readFileSync} from "node:fs";
import {join} from "node:path";
vi.mock("../src/core/storage",()=>({saveReceipt:vi.fn(async()=>{throw new Error("storage unavailable")})}));
import {handlePaymentMethod,resetBinCacheForTests} from "../src/handlers/paymentMethod";
afterEach(()=>vi.unstubAllGlobals());
it("refuses a real captured positive when receipt storage fails",async()=>{
 resetBinCacheForTests();
 const raw=readFileSync(join(__dirname,"fixtures/payment-method/open-bin-411111.json"),"utf8");
 vi.stubGlobal("fetch",async(u:unknown)=>new Response(String(u).includes("api.dharun.dev")?raw:"{}"));
 await expect(handlePaymentMethod({bin:"411111"})).rejects.toMatchObject({status:502,code:"RECEIPT_PERSIST_FAILED"});
});
