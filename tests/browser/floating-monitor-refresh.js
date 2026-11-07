// Run in an isolated BB Browser Automation session on a BB page with Host Pulse installed.
// A cached reading must not postpone the next server-metric refresh after reopening.
const p=await browser.getPage('main');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function click(label){const line=(await p.snapshot({interactive:true})).split('\n').find(l=>l.includes(`button "${label}"`));const ref=line?.match(/\[ref=(e\d+)\]/)?.[1];if(!ref)throw new Error('Missing '+label);await p.click('ref/'+ref);}
const metrics = {
  timestamp: new Date().toISOString(), refreshIntervalMs: 5000,
  host: { hostname: "layout-test", platform: "linux", release: "test", arch: "x64", uptimeSeconds: 1000 },
  cpu: { model: "Test CPU", cores: 16, speedMHz: 3000, usagePercent: 100, perCoreUsagePercent: Array(16).fill(100), loadAverage: [16, 16, 16] },
  memory: { totalBytes: 32 * 1024 ** 3, usedBytes: 32 * 1024 ** 3, freeBytes: 0, availableBytes: 0, cachedBytes: 0, buffersBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0, usagePercent: 100 },
  disk: { mount: "/", totalBytes: 1024 ** 4, usedBytes: 1024 ** 4, freeBytes: 0, usagePercent: 100 }, diskIo: null,
  network: { interface: "test0", rxBytesPerSecond: 1023.9 * 1024 ** 2, txBytesPerSecond: 1023.9 * 1024 ** 2, rxTotalBytes: 1024 ** 4, txTotalBytes: 1024 ** 4 },
  processes: { available: true, total: 100, running: 16, top: [],
    topCpu: { pid: 4194303, name: "long-process-name-for-layout", cpuPercent: 100 },
    topMemory: { pid: 4194303, name: "long-memory-process-name", rssBytes: 31.99 * 1024 ** 3 },
  },
  runtime: { pid: 123, nodeVersion: "v26.0.0", processUptimeSeconds: 1000, rssBytes: 1024 ** 3, heapUsedBytes: 1024 ** 2, heapTotalBytes: 2 * 1024 ** 2, externalBytes: 0 },
  health: { status: "critical", issues: [] }, history: [],
};

const key='host-pulse-floating-monitor-v1';
const saved=await p.evaluate(key=>localStorage.getItem(key),key);
const calls=[];
const handler=request=>{
 if(request.url().includes('/plugins/host-pulse/rpc/metrics_snapshot')){
  const now=Date.now();calls.push(now);
  const snapshot={...metrics,timestamp:new Date(now).toISOString(),cpu:{...metrics.cpu,usagePercent:calls.length*10}};
  void request.respond({status:200,contentType:'application/json',body:JSON.stringify({ok:true,result:snapshot})}).catch(()=>{});
 }else void request.continue().catch(()=>{});
};
await p.setViewport({width:1280,height:900,isMobile:false,hasTouch:false});
await p.setRequestInterception(true);p.on('request',handler);
try{
 await p.evaluate(()=>localStorage.setItem('host-pulse-floating-monitor-v1',JSON.stringify({version:1,visible:true,position:{x:450,y:100}})));
 await p.reload({waitUntil:'domcontentloaded'});
 await p.waitForFunction(()=>document.querySelector('.host-pulse-float-status')?.textContent==='Live',{timeout:10000});
 await pause(Math.max(0,3000-(Date.now()-calls[0])));
 await click('Hide floating monitor');
 await p.waitForFunction(()=>!document.querySelector('.host-pulse-float'),{timeout:3000});
 await pause(300);
 await click('Host Pulse');
 await p.waitForSelector('.host-pulse-float',{timeout:3000});
 const reopenedAt=Date.now()-calls[0];
 if(reopenedAt>=4900||calls.length!==1)throw new Error('Test setup missed the cached-reading window');
 await pause(Math.max(0,6100-(Date.now()-calls[0])));
 const result={reopenedAt,observedAt:Date.now()-calls[0],requests:calls.map(t=>t-calls[0]),cpu:await p.evaluate(()=>document.querySelector('.host-pulse-float-metric strong')?.textContent)};
 console.log(JSON.stringify(result));
 if(calls.length<2)throw new Error('CPU remained on its first reading beyond the 5s refresh deadline after reopening');
 if(result.cpu!=='20%')throw new Error('The refreshed CPU reading did not reach the visible card');
}finally{
 await p.setRequestInterception(false);p.off('request',handler);
 await p.evaluate(({key,saved})=>{if(saved===null)localStorage.removeItem(key);else localStorage.setItem(key,saved);},{key,saved});
 await p.reload({waitUntil:'domcontentloaded'});
}
