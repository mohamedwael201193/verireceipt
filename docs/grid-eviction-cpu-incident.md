# Overflow eviction CPU incident, 22 November 2026

Private review notes, not a live deployment claim.

## Observed incident

At 22:54:06 Cairo Render automatically restarted instancehgc 2 l after a 5 second HTTP health timeout. Last deployment remainsb 25 a 5 bc; no operator restart, deployment or environment change. At 22:56 CPU remained 0.94-0.99 cores on 1 core, memory 185-211 MBof 2 GB, persistentdisk 16.2 MBof 1 GB. PostgreSQL control planeavailable, app-sidepingunverified. Last pre-restart ordinary logElering 384 rows at 22:52:54, noNYISOcompletion; after restart no firstEleringcompletion. This is not evidence of an epoch boundary.

Real current Elering 15,908 bytes andNYISO 164,313/233,111 bytes returned 200. Captured payload replay with an empty disposable SQLite store finished 575 ms,maxsampledlag 202 ms. That small-store test does not reproduce the outage and does not clear the persistent-store path.

## Reproduced defect and smallest fix

Both SQLite and PostgreSQL overflow purge call the same synchronous selectGridEvictions. Over 25,000 rows it sorts the whole store, repeatedly computing timezone/business-day finality inside comparator calls and again during selection. The calendar helper constructs an Intl.DateTimeFormat for each timezone conversion. At 25,001 realisticNYISOrows the old code failed an OS-enforced 2.5 second regression and still did not complete under a separate 15 seconddeadline. It blocks the event loop while doing so, and no async source timeout can interrupt it.

Patch: precompute priority once for each market+interval outside the comparator, keep node-specific configured references outside the shared priority cache, sort only primitive ranks and original tie-breakers, reuse at most 8 stateless timezoneformatters. No finality/holiday/retention/price/receipt/endpoint/payer/buyer change. The 25001 row repro finishes 104 ms after this patch; child regression 267 msincludingstartup. Actual live stack and currentPGrowcount were not captured, so this is a confirmed blocking defect and strong incident explanation, not a proven captured live stack.

## Verification

- New regression RED on unmodifiedHEAD: OS ETIMEDOUT 2500 ms, onefail/onepass.
- Same two tests GREEN on fixed source.
- Exact ordering/property check preserves invalid keys, configured node-specific references, duplicate intervals across zones and source array immutability for different caps.
- Existing grid and SQLite storage compatibility 172 pass,5 PostgreSQLcases skipped becauseDATABASE_URLnotprovided.
- TypecheckPASS.
- Broad fullsuitewasinterruptedat 120 secondexecutioncap; no complete pass claimed. Targeted remaining checks recorded separately.

## Deployment plan, requires Mo's separate confirmation

After independentKEEP, publish only reviewed commit on main, verify remoteSHA. MainpushbuildsVercelautomatically, so verify that too. RenderautoDeploy=no, so no backend effects from push. For backend, only after explicitMoapproval, POST the exact reviewedSHA to existingRender service without cacheclear, restart, environment or plan change. KeepMIGRATE_ON_BOOT=0, disk 1 GB/var/data,1 instance andBUYERoff. Observe deployment and verify/health 200,exactSHA,PostgreSQLping,uptimeandCPU. Exercise only bounded ordinary source/receipt checks, no protected evaluation replay. Watch at least two 5 minute grid cycles and oneoverflow path. Persist failure evidence and report real result; never assert recovery untillivehealthandCPUverify. Rollback requires separate decision and may restore blocking; it is not an automatic cure. No hostmutationhappenedintheprep.

How this fits VeriReceipt: keep the evidence store's exact eviction contract and price finality while preventing maintenance work from blocking all receipted intents.

## 23:03 live update

Without any operator action, /health recovered 200 on unchangedb 25,uptime 543 s,PGOK 1 ms. Grid job registry now reportsmax 235990 ms (3 m 56 s),2 runs,lastnormal 5001 msat 22:59:08. This supplies additional incident evidence for the grid maintenance path. No deployment or manual restart was needed for that transient recovery, but the unchanged code still has the reproduced overflow defect.
