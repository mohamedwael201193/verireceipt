#!/usr/bin/env python3
"""Offline-only Chromium-to-real-buyer-stack rehearsal. Never a paid success demo."""
import base64,json,os,pathlib,shutil,socket,subprocess,sys,tempfile,time,urllib.parse,urllib.request
import websocket
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/buyer-joined-rehearsal');OUT.mkdir(parents=True,exist_ok=True)
BASE='https://verireceipt.vercel.app'
for port in [8771,9231]:
 with socket.socket() as probe:
  probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);probe.bind(('127.0.0.1',port))
profile=tempfile.mkdtemp(prefix='buyer-joined-chrome-')
bridge=subprocess.Popen(['node',str(ROOT/'scripts/rehearse-buyer.cjs')],cwd=ROOT,stdout=open(OUT/'bridge.log','w'),stderr=subprocess.STDOUT)
chrome=None;ws=None
try:
 deadline=time.monotonic()+15
 while True:
  try:urllib.request.urlopen('http://127.0.0.1:8771/state').read();break
  except Exception:
   if bridge.poll() is not None or time.monotonic()>deadline:raise RuntimeError('Bridge did not start; inspect bridge.log')
   time.sleep(.05)
 chrome=subprocess.Popen([os.environ.get('CHROME_BIN','google-chrome'),'--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--disable-component-update','--no-first-run','--no-default-browser-check','--remote-debugging-port=9231','--remote-allow-origins=http://127.0.0.1:9231','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--user-data-dir='+profile,'about:blank'],stdout=open(OUT/'chrome.log','w'),stderr=subprocess.STDOUT)
 deadline=time.monotonic()+15
 while True:
  try:tabs=json.load(urllib.request.urlopen('http://127.0.0.1:9231/json/list'));target=next(x['webSocketDebuggerUrl'] for x in tabs if x['type']=='page');break
  except Exception:
   if time.monotonic()>deadline:raise
   time.sleep(.05)
 ws=websocket.create_connection(target,origin='http://127.0.0.1:9231',timeout=20);seq=0;responses={}
 def call(method,params=None):
  global seq
  seq+=1;ident=seq;ws.send(json.dumps({'id':ident,'method':method,'params':params or {}}))
  while True:
   event=responses.pop(ident) if ident in responses else json.loads(ws.recv())
   if 'id' in event and event['id']!=ident:responses[event['id']]=event;continue
   if event.get('method')=='Fetch.requestPaused':serve(event['params'])
   if event.get('id')==ident:
    if 'error' in event:raise RuntimeError(event['error'])
    return event.get('result',{})
 def serve(event):
  request=event['request'];url=urllib.parse.urlsplit(request['url']);headers=[];status=404;body=b'OFFLINE DEFAULT DENY'
  if url.scheme=='https' and url.netloc=='verireceipt.vercel.app':
   if url.path.startswith('/api/v1/buyer/'):
    incoming={'method':request['method'],'url':url.path[4:],'headers':{k:v for k,v in request['headers'].items() if k.lower() not in ['host','content-length','connection']}}
    if 'postData' in request:incoming['payload']=request['postData']
    result=json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8771/bridge',data=json.dumps(incoming).encode(),headers={'Content-Type':'application/json'})))
    status=result['status'];body=result['body'].encode()
    for key,value in result['headers'].items():
     if key.lower() not in ['content-length','transfer-encoding','connection','content-encoding']:
      for item in value if isinstance(value,list) else [value]:headers.append({'name':key,'value':str(item)})
   else:
    relative='index.html' if url.path in ['/buyer','/buyer/'] else url.path.lstrip('/')
    file=(ROOT/'frontend/dist'/relative).resolve();dist=(ROOT/'frontend/dist').resolve()
    if dist in file.parents and file.is_file():
     status=200;body=file.read_bytes();mime='text/html' if file.suffix=='.html' else 'text/javascript' if file.suffix=='.js' else 'text/css' if file.suffix=='.css' else 'application/octet-stream'
     headers=[{'name':'Content-Type','value':mime}]
     if file.suffix=='.html':body=body.replace(b'<head>',b'<head><script>document.addEventListener("DOMContentLoaded",()=>{const b=document.createElement("div");b.textContent="OFFLINE JOINED REHEARSAL / NO SIGNATURE OR PAYMENT";b.style="background:#ffd98b;color:#302b1e;padding:10px;font:12px monospace;text-align:center";document.body.prepend(b);});</script>')
  call('Fetch.fulfillRequest',{'requestId':event['requestId'],'responseCode':status,'responseHeaders':headers,'body':base64.b64encode(body).decode()})
 def evaluate(expression):
  result=call('Runtime.evaluate',{'expression':expression,'returnByValue':True})
  if 'exceptionDetails' in result:raise RuntimeError(result['exceptionDetails'])
  return result.get('result',{}).get('value')
 def wait(expression):
  deadline=time.monotonic()+15
  while not evaluate(expression):
   if time.monotonic()>deadline:raise RuntimeError('UI condition timed out: '+expression)
   time.sleep(.05)
 def click(label):
  if not evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent==='+json.dumps(label)+');if(!b||b.disabled)return false;b.click();return true})()'):raise RuntimeError('Missing or disabled action '+label)
 call('Page.enable');call('Fetch.enable',{'patterns':[{'urlPattern':'*','requestStage':'Request'}]})
 call('Emulation.setDeviceMetricsOverride',{'width':1440,'height':1100,'deviceScaleFactor':1,'mobile':False})
 call('Page.navigate',{'url':BASE+'/buyer'})
 wait('!!document.querySelector(".buyer-empty") && !document.querySelector(".buyer-card button").disabled')
 click('Prepare free preview');wait('!!document.querySelector(".buyer-primary")')
 assert evaluate('document.querySelector(".buyer-primary").textContent')=='Buy once for 0.01 test USDC'
 click('Buy once for 0.01 test USDC');wait('!!document.querySelector("#buyer-result")')
 wait('document.querySelector("#buyer-result").textContent.includes("uncertain")')
 cookies=call('Network.getCookies',{'urls':[BASE+'/buyer']})['cookies']
 owner=next(c for c in cookies if c['name']=='__Host-vr_buyer')
 assert owner['secure'] and owner['httpOnly'] and owner['sameSite']=='Strict','Owner cookie flags mismatch'
 before=json.load(urllib.request.urlopen('http://127.0.0.1:8771/state'))
 assert before['executions']==before['checkpoints']==before['signerInvocations']==1,before
 assert before['signaturesProduced']==before['paidTransportCalls']==0,before
 assert len(before['durableJobs'])==1 and before['durableJobs'][0]['checkpoint']==1 and before['durableJobs'][0]['reserved']==1 and before['durableJobs'][0]['state']=='uncertain',before
 call('Page.reload');wait('!!document.querySelector("#buyer-result")')
 wait('document.querySelector("#buyer-result").textContent.includes("Unknown, up to 0.01 test USDC")')
 click('Check result, read only');wait('!document.querySelector(".buyer-secondary").disabled')
 evidence=evaluate('document.querySelector("a[download]").getAttribute("href")')
 call('Runtime.evaluate',{'expression':'window.rehearsalEvidence=null;fetch('+json.dumps(evidence)+').then(async r=>{window.rehearsalEvidence={status:r.status,body:await r.text()}})'})
 wait('!!window.rehearsalEvidence');data=evaluate('window.rehearsalEvidence');assert data['status']==200,data
 (OUT/'evidence.json').write_text(data['body'])
 after=json.load(urllib.request.urlopen('http://127.0.0.1:8771/state'))
 assert after['executions']==after['checkpoints']==after['signerInvocations']==1,after
 assert after['signaturesProduced']==after['paidTransportCalls']==0,after
 assert len([r for r in after['api'] if r['method']=='POST' and r['url'].endswith('/buy')])==1,after
 (OUT/'report.json').write_text(json.dumps({'label':'OFFLINE SYNTHETIC CHALLENGE, REAL ROUTE/STORE/RUNTIME, THROW-ONLY SIGNER. NOT A PURCHASE.', 'secure_owner_cookie_flags':{'secure':owner['secure'],'httpOnly':owner['httpOnly'],'sameSite':owner['sameSite']},'before_refresh':before,'after_refresh_check_evidence':after},indent=2))
 evaluate('document.querySelectorAll(".buyer-page details").forEach(d=>d.open=true)')
 height=evaluate('Math.ceil(document.documentElement.scrollHeight)')
 shot=call('Page.captureScreenshot',{'format':'png','captureBeyondViewport':True,'clip':{'x':0,'y':0,'width':1440,'height':height,'scale':1}})
 (OUT/'joined-rehearsal.png').write_bytes(base64.b64decode(shot['data']))
 print('PASS: real browser cookie/session -> routes -> SQLite checkpoint -> real ranked runtime -> deliberate no-sign HOLD -> refresh GET -> evidence. Zero signatures, zero paid transport calls.')
 print('Artifacts:',OUT)
finally:
 if ws:ws.close()
 for process in [chrome,bridge]:
  if process:
   process.terminate()
   try:process.wait(timeout=8)
   except subprocess.TimeoutExpired:process.kill();process.wait()
 shutil.rmtree(profile,ignore_errors=True)
