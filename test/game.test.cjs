const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const {patterns,motifs,score,accuracy,mastered,Transport,Detector,selected,audioRun,weakest,mount,load} = require('../game');
const beat = .75;
const times = p => [...p.beats].flatMap((k,b)=>motifs[k][1].map(s=>(b+s/4)*beat));

test('every named example grades perfectly; subpattern totals account for every beat',()=>{
  for (const p of patterns) {
    assert.equal(p.beats.length,8); assert.equal(p.beats[0],'Q');
    const a = times(p), {total,parts} = score(p,beat,a);
    assert.equal(accuracy(total),1); assert.equal(total.attempts,1); assert.equal(total.hits,a.length);
    assert.equal(Object.values(parts).reduce((n,s)=>n+s.attempts,0),8);
    assert.equal(accuracy(score(p,beat,[]).total),0);
  }
});
test('one-to-one, chooses closest duplicate, strict reply ownership and bounded fine windows',()=>{
  const p = {beats:'SRRRRRRR'}, a = times(p), dt = beat/4;
  const {total,parts} = score(p,beat,[-.001, .001, 0, dt*1.49, dt*2, dt*3+.01, beat+.2,beat*8]);
  assert.equal(a.length,4); assert.equal(total.hits,3); assert.equal(total.extras,3); assert.equal(total.misses,1);
  assert.equal(parts.R.extras,1); assert.ok(Math.abs(total.absMs-10)<.00001); assert.equal(accuracy(total),3/7);
});
test('mastery uses unrounded last three and weak practice ranks observed error',()=>{
  assert.ok(mastered([.8,.8])); assert.ok(mastered([1,0,.8])); assert.ok(!mastered([1,.79,.799,1]));
  const db=Object.fromEntries(patterns.slice(0,2).map((p,i)=>['bass:'+p.name,{attempts:1,hits:4-i,misses:i,extras:0}]));
  assert.equal(weakest(db,'bass'),patterns[1]); assert.equal(weakest(db,'bass',patterns[1]),patterns[0]);
});
test('audio scheduling: four cycles on one grid, new pattern selected after tail buffer',()=>{
  const events = [], results = [], start=1;
  const transport = new Transport(start,80,patterns[0],(p,r,h)=>{results.push(r);return mastered(h)?patterns[2]:p;});
  for (let i=0;i<4*16*beat*1000;i+=10) {
    const now = start+i/1000-.09, captured=now-.15;
    transport.schedule(now,(at,k)=>events.push([at,k]));
    if(i%750===240) transport.receive(captured); // exactly one per beat, including example (ignored)
    transport.processed(captured);
  }
  const clicks=events.filter(e=>e[1]!=='note' && e[0]<start+64*beat);
  assert.equal(clicks.length,64); clicks.forEach(([t,k],i)=>{assert.equal(t,start+i*beat);assert.equal(k,i%4?'click':'accent');});
  for (let c=0;c<4;c++) {
    const bar=start+c*16*beat;
    assert.deepEqual(events.filter(e=>e[1]==='note' && e[0]>=bar && e[0]<bar+16*beat).map(e=>e[0]-bar), times(c<2?patterns[0]:patterns[2]));
  }
  assert.equal(results[0].total.hits,8); assert.equal(results[0].total.extras,0);
  assert.throws(()=>transport.schedule(1000,()=>{}),/fell behind/);
});
test('energy rise detector rejects silence and a sustained tone; distinct reattacks survive',()=>{
  const d=new Detector(), hits=[]; let t=0;
  for(const level of [0,.12,.12,.12,0,0,.14]) for(let i=0;i<6;i++) {
    const pcm=new Float32Array(512).fill(level); d.scan(pcm,t,48000,x=>hits.push(x)); t+=512/48000;
  }
  assert.equal(hits.length,2);
});
test('plucked low bass/guitar waveforms do not retrigger during ring-out',()=>{
  for (const freq of [30.87,41.2,82.4,329.6]) {
    const detector = new Detector(), strikes=[];
    for (let i=0;i<120;i++) {
      const pcm=Float32Array.from({length:512},(_,j)=>{const t=(i*512+j)/48000%0.64;return .15*Math.exp(-5*t)*Math.sin(2*Math.PI*t*freq);});
      detector.scan(pcm,i*512/48000,48000,t=>strikes.push(t));
    }
    assert.equal(strikes.length,2,`${freq} Hz`);
  }
});
test('storage rejects invalid counts instead of replacing historical data',()=>{
  const total=score(patterns[0],beat,[0]).total, key='bass:'+patterns[0].name;
  const storage=s=>({getItem:()=>JSON.stringify({[key]:s})}); assert.deepEqual(load(storage(total))[key],total);
  for(const invalid of [{misses:-2},{attempts:.25},{hits:null},{signedMs:'late'}]) assert.throws(()=>load(storage({...total,...invalid})),/progress/);
});

const flush=()=>new Promise(r=>setImmediate(r));
const desktop=()=>({isDesktop:true,audio:{getCurrentDevice:async()=>({input:'DI',inputType:'Core Audio'}),listSources:async()=>[{id:0,active:true,deviceKey:0,inputChannel:1}]}});
function fixture() {
  const nodes=[], timers=new Map(), contexts=[], tracks=[], requests=[]; let id=0;
  class Node {constructor(){nodes.push(this);this.gain={};this.connections=[];} connect(...args){this.connections.push(args);} disconnect(){this.disconnected=true;} }
  class Context {constructor(){contexts.push(this);this.currentTime=0;this.state='running';this.sampleRate=48000;this.destination={};} async resume(){} async close(){this.state='closed';} createMediaStreamSource(){return new Node();} createChannelSplitter(){return new Node();} createGain(){return new Node();} createScriptProcessor(){return this.processor=new Node();}}
  const input={id:'DI-id',channel:'right'}, media={enumerateDevices:async()=>[{kind:'audioinput',label:'DI',deviceId:'DI-id'}],getUserMedia:async c=>{requests.push(c);const track={label:'DI',readyState:'live',getSettings:()=>({deviceId:'DI-id',channelCount:2}),stop(){this.stopped=true;}};tracks.push(track);return {getTracks:()=>[track],getAudioTracks:()=>[track]};}};
  const w={navigator:{mediaDevices:media},AudioContext:Context,setInterval(fn){timers.set(++id,fn);return id;},clearInterval(k){timers.delete(k);},localStorage:{getItem(k){return k==='slopsmith_notedetect'?JSON.stringify({deviceId:'DI-id',channel:'right'}):null;}}};
  return {w,nodes,timers,contexts,tracks,media,input,requests};
}
test('no OS default, ambiguous native label or stale consent substitution',async()=>{
  const f=fixture(); f.w.localStorage.getItem=()=>'{"deviceId":"default","channel":"mono"}';
  await assert.rejects(selected(f.w),/explicit/); f.w.feedBackDesktop=desktop();
  const input=await selected(f.w); assert.equal(input.channel,'right');
  const [device]=await f.media.enumerateDevices(); f.media.enumerateDevices=async()=>[device,{...device,deviceId:'other'}];
  await assert.rejects(selected(f.w),/unique/);
  let failure; audioRun(f.w,input,0,{fail:e=>failure=e}); await flush();
  assert.match(failure.message,/unique/); assert.equal(f.requests.length,0);assert.equal(f.contexts[0].state,'closed');
});
test('permission resolution after stop only releases the late stream',async()=>{
  const f=fixture(), take=f.media.getUserMedia; let grant;
  f.media.getUserMedia=()=>new Promise(r=>grant=async()=>r(await take({})));
  const run=audioRun(f.w,f.input,0,{fail:assert.fail}); await flush(); run.stop();await grant();await flush();
  assert.equal(f.contexts[0].state,'closed');assert.ok(f.tracks[0].stopped);assert.equal(f.nodes.length,0);assert.equal(f.timers.size,0);
});
test('verified right-channel capture terminates on discontinuity and cleans all resources',async()=>{
  const f=fixture();let error,ready=0;
  audioRun(f.w,f.input,0,{fail:e=>error=e,ready(){ready++;return {processed(){}};}}); await flush();
  assert.deepEqual(f.requests[0].audio.deviceId,{exact:'DI-id'});assert.equal(f.nodes[1].connections[0][1],1);
  const ctx=f.contexts[0], event={playbackTime:1,inputBuffer:{getChannelData:()=>new Float32Array(512)}};
  ctx.processor.onaudioprocess(event);ctx.processor.onaudioprocess(event);
  assert.equal(ready,1);assert.match(error.message,/discontinuous/);assert.equal(ctx.processor.onaudioprocess,null);
  assert.ok(f.nodes.every(n=>n.disconnected));assert.ok(f.tracks[0].stopped);assert.equal(f.timers.size,0);
});
test('positive correction moves each onset earlier on the scheduling clock',async()=>{
  const f=fixture(), hits=[];let watermark;
  const run=audioRun(f.w,f.input,.08,{ready:()=>({receive:t=>hits.push(t),processed:t=>watermark=t}),attack(){},fail:assert.fail});await flush();
  f.contexts[0].processor.onaudioprocess({playbackTime:2,inputBuffer:{getChannelData:()=>new Float32Array(512).fill(.1)}});
  assert.deepEqual(hits,[2-.08-512/48000]);assert.equal(watermark,2-.08);run.stop();
});
test('a changed native identity stops live capture; wrong returned channel count never starts',async()=>{
  for(const wrongChannel of [false,true]) {
    const f=fixture();f.w.feedBackDesktop=desktop();let failure;const input=await selected(f.w);
    const take=f.media.getUserMedia;f.media.getUserMedia=async c=>{const s=await take(c);if(wrongChannel)s.getAudioTracks()[0].getSettings=()=>({deviceId:input.id,channelCount:1});return s;};
    audioRun(f.w,input,0,{fail:e=>failure=e,ready:assert.fail});await flush();
    if(!wrongChannel){f.w.feedBackDesktop.audio.listSources=async()=>[{id:0,deviceKey:0,active:true,inputChannel:0}];await [...f.timers.values()].at(-1)();}
    assert.match(failure.message,wrongChannel?/verify selected input channel/:/input changed/);assert.ok(f.tracks[0].stopped);assert.equal(f.timers.size,0);
  }
});
test('stage Quit intercepts scoring handler, desktop prepare does not capture without confirmation',async()=>{
  const f=fixture();f.w.feedBackDesktop=desktop();const quit=new EventTarget(),doc=new EventTarget(), routes=[],listeners=new Map(),els=new Map();
  doc.getElementById=()=>quit;f.w.document=doc;
  f.w.feedBack={workingTuning:{get:()=>({instrument:'bass'})},navigate:r=>routes.push(r),on:(k,v)=>listeners.set(k,v),off:k=>listeners.delete(k)};
  const session=mount(f.w,{querySelector(s){if(!els.has(s))els.set(s,{});return els.get(s);}});await flush();
  assert.match(els.get('[data-r="start"]').textContent,/Electron/);assert.equal(f.requests.length,0);
  quit.addEventListener('click',()=>assert.fail('public host quit')); const e=new Event('click',{cancelable:true}); quit.dispatchEvent(e);
  assert.ok(e.defaultPrevented);assert.deepEqual(routes,['home']);assert.equal(listeners.size,0);session.stop();
});
test('host spec registers once, immediate and queued',()=>{
  const script=fs.readFileSync(require.resolve('../game'),'utf8');for(const immediate of [true,false]) {
    const regs=[],window=immediate?{feedBackMinigames:{register:s=>regs.push(s)}}:{};
    for(let i=0;i<2;i++)vm.runInNewContext(script,{window});const specs=immediate?regs:window.__feedBackMinigamesPending;
    assert.deepEqual(Array.from(specs,s=>s.id),['rhythm_recall']);
  }
});
