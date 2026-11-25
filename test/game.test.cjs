const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const {patterns,motifs,score,accuracy,mastered,Transport,selected,audioRun,weakest,mount,load} = require('../game');
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
function worklet(start=0,rate=48000) {
  const messages=[]; let Processor;
  const scope=vm.createContext({sampleRate:rate,currentFrame:start,
    AudioWorkletProcessor:class {port={postMessage:m=>messages.push(structuredClone(m))};},
    registerProcessor(name,Ctor){assert.equal(name,'rhythm-recall-onsets');Processor=Ctor;}});
  vm.runInContext(fs.readFileSync(require.resolve('../assets/onset-processor.js'),'utf8'),scope);
  const p=new Processor();return {scope,messages,scan(pcm){p.process([pcm?[pcm]:[]]);scope.currentFrame+=pcm?.length??128;}};
}
test('actual processor batches silent heartbeats and carries partial analysis windows',()=>{
  const p=worklet(8000);p.scan(null);const start=8128;
  for(const n of [96,160,128,127])p.scan(new Float32Array(n));
  assert.deepEqual(p.messages,[]);p.scan(new Float32Array(14).fill(.1));
  assert.deepEqual(p.messages,[{startFrame:start,endFrame:start+512,onsets:[]}]);
  p.scan(new Float32Array(499).fill(.1));
  assert.deepEqual(p.messages[1],{startFrame:start+512,endFrame:start+1024,onsets:[start+512]});
  p.scan(null);p.scan(new Float32Array(128));
  assert.deepEqual(p.messages[2],{type:'gap',startFrame:start+1024,expectedFrame:start+1024,endFrame:start+1152});
  assert.throws(()=>worklet().scan(new Float32Array(128).fill(NaN)),/Invalid/);
});
test('energy rise detector rejects silence and a sustained tone; distinct reattacks survive',()=>{
  const d=worklet();
  for(const level of [0,.12,.12,.12,0,0,.14]) for(let i=0;i<6;i++) {
    d.scan(new Float32Array(512).fill(level));
  }
  assert.deepEqual(d.messages.flatMap(m=>m.onsets),[6*512,36*512]);
});
test('gap drops queued attack and partial RMS; resumed detector has fresh envelope and guard',()=>{
  const p=worklet(), hot=n=>new Float32Array(n).fill(.2);
  p.scan(hot(193)); p.scope.currentFrame+=37; p.scan(hot(512));
  assert.deepEqual(p.messages,[{type:'gap',startFrame:0,expectedFrame:193,endFrame:230},
    {startFrame:230,endFrame:742,onsets:[230]}]);
});
test('plucked low bass/guitar waveforms do not retrigger during ring-out',()=>{
  for (const freq of [30.87,41.2,82.4,329.6]) {
    const detector = worklet();
    for (let i=0;i<120;i++) {
      const pcm=Float32Array.from({length:512},(_,j)=>{const t=(i*512+j)/48000%0.64;return .15*Math.exp(-5*t)*Math.sin(2*Math.PI*t*freq);});
      detector.scan(pcm);
    }
    assert.equal(detector.messages.flatMap(m=>m.onsets).length,2,`${freq} Hz`);
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
  const loader={async addModule(url){assert.equal(url,'/api/plugins/rhythm_recall/assets/onset-processor.js?v='+require('../plugin.json').version);}};
  class Context {constructor(){contexts.push(this);this.audioWorklet=loader;this.currentTime=0;this.state='running';this.sampleRate=48000;this.destination={};} async resume(){} async close(){this.state='closed';} createMediaStreamSource(){return new Node();} createChannelSplitter(){return new Node();} createGain(){return new Node();}}
  class WorkletNode extends Node {constructor(ctx,name,options){super();ctx.processor=this;assert.equal(name,'rhythm-recall-onsets');this.options=options;this.port={close(){this.closed=true;}};}}
  const input={id:'DI-id',channel:'right'}, media={enumerateDevices:async()=>[{kind:'audioinput',label:'DI',deviceId:'DI-id'}],getUserMedia:async c=>{requests.push(c);const track={label:'DI',readyState:'live',getSettings:()=>({deviceId:'DI-id',channelCount:2}),stop(){this.stopped=true;}};tracks.push(track);return {getTracks:()=>[track],getAudioTracks:()=>[track]};}};
  const w={navigator:{mediaDevices:media},AudioContext:Context,setInterval(fn){timers.set(++id,fn);return id;},clearInterval(k){timers.delete(k);},localStorage:{getItem(k){return k==='slopsmith_notedetect'?JSON.stringify({deviceId:'DI-id',channel:'right'}):null;}}};
  w.AudioWorkletNode=WorkletNode;
  return {w,nodes,timers,contexts,tracks,media,input,requests,loader};
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
  const ctx=f.contexts[0], event={data:{startFrame:0,endFrame:512,onsets:[]}};
  ctx.processor.port.onmessage(event);ctx.processor.port.onmessage(event);
  assert.equal(ready,1);assert.match(error.message,/discontinuous/);assert.equal(ctx.processor.port.onmessage,null);assert.ok(ctx.processor.port.closed);
  assert.ok(f.nodes.every(n=>n.disconnected));assert.ok(f.tracks[0].stopped);assert.equal(f.timers.size,0);
});
test('batch arrival jitter does not shift onsets or the exclusive scoring watermark',async()=>{
  for(const correction of [.08,-.06]) {
    const f=fixture(),events=[];
    const run=audioRun(f.w,f.input,correction,{ready:()=>({receive:t=>events.push(['onset',t]),processed:t=>events.push(['end',t])}),attack(){},fail:assert.fail});await flush();
    const ctx=f.contexts[0],p=worklet(96000,44100);ctx.sampleRate=44100;ctx.currentTime=2.35;
    const pcm=new Float32Array(4096);pcm.fill(.1,0,128);pcm.fill(.1,2048,2176);p.scan(pcm);
    ctx.processor.port.onmessage({data:p.messages[0]});
    assert.deepEqual(events,[['onset',96000/44100-correction],['onset',98048/44100-correction],['end',100096/44100-correction]]);run.stop();
  }
});
test('Windows forward gap through shipped worklet, UI, clock, mastery and practice history',async()=>{
  for(const [delay,memoryOnly] of [[62.5,false],[-62.5,false],[62.5,true]]) {
    const f=fixture(), els=new Map(), saves=[], clicks=[], rate=32000;
    const doc=f.w.document=new EventTarget();doc.getElementById=()=>new EventTarget();
    f.w.feedBack={workingTuning:{get:()=>({instrument:'bass'})},on(){},off(){},navigate(){}};
    f.w.localStorage.setItem=(k,v)=>{saves.push(JSON.parse(v));if(memoryOnly)throw Error('quota');};
    const session=mount(f.w,{querySelector(s){const el={};els.set(s.slice(9,-2),el);return el;}});await flush();
    els.get('tempo').valueAsNumber=120;els.get('delay').valueAsNumber=delay;els.get('mode').value='course';
    els.get('start').onclick();await flush();const ctx=f.contexts[0], p=worklet(0,rate);ctx.sampleRate=rate;
    const gain=ctx.createGain.bind(ctx);ctx.createGain=()=>Object.assign(gain(),{gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}}});
    ctx.createOscillator=()=>Object.assign(gain(),{frequency:{},start(t){if(this.frequency.value!==220)clicks.push(t);},stop(){this.onended?.();}});
    const first=512/rate+.18, physical=t=>Math.round((first+t+delay/1000)*rate);
    const picks=new Set(Array.from({length:24},(_,i)=>physical(4+Math.floor(i/8)*8+(i%8)*.5)+128));
    function scanTo(end) {
      while(p.scope.currentFrame<end) {
        const at=p.scope.currentFrame, pcm=new Float32Array(Math.min(512,end-at));
        for(const pick of picks) if(pick<at+pcm.length && pick+128>at)pcm.fill(.16,Math.max(0,pick-at),Math.min(pcm.length,pick+128-at));
        p.scan(pcm);ctx.currentTime=p.scope.currentFrame/rate;
        for(const data of p.messages.splice(0)) ctx.processor.port.onmessage({data});
        [...f.timers.values()][0]();
      }
    }
    // Empty quantum starts just AFTER close, but the unreported batch
    // includes the reply tail. Arrival time alone would grade this take.
    const close=physical(16);scanTo(close+1);assert.equal(saves.length,1);
    const result=els.get('result').textContent, history=els.get('history').textContent;
    p.scan(null);scanTo(close+1024);
    assert.match(els.get('status').textContent,/expected frame .*observed frame .*gap .* ms.*Reply not scored/);
    assert.equal(saves.length,1);assert.equal(els.get('result').textContent,result);assert.equal(els.get('history').textContent,history);
    assert.equal(els.get('pattern').textContent,patterns[0].name);
    // Another gap ENDS exactly at retry reply start; it is example-only.
    scanTo(physical(20)-128);p.scan(null);scanTo(physical(20)+512);
    assert.match(els.get('status').textContent,/Outside the reply/);scanTo(physical(24)+1024);
    if(memoryOnly){assert.equal(saves.length,1);assert.match(els.get('storage').textContent,/memory only/);}
    else {assert.equal(saves.length,2);assert.equal(saves[1]['bass:'+patterns[0].name].attempts,2);assert.equal(saves[1]['bass:Q'].attempts,16);}
    assert.match(els.get('history').textContent,/Four on the floor: 2 replies/);assert.match(els.get('result').textContent,/Mastered/);
    assert.equal(els.get('pattern').textContent,patterns[1].name);
    assert.deepEqual(clicks,Array.from({length:49},(_,i)=>first+i*.5));
    assert.equal(f.contexts.length,1);session.stop();assert.ok(f.tracks[0].stopped);assert.equal(f.timers.size,0);
  }
});
test('backward, prolonged, flapping and malformed input stop once without grading',async()=>{
  for(const mode of ['reset','long','repeated','invalid','replay','unknown']) {
    const f=fixture(),errors=[];let processed=0;
    audioRun(f.w,f.input,0,{ready:()=>({gap(){},processed(){processed++;}}),fail:e=>errors.push(e.message)});await flush();
    const ctx=f.contexts[0],p=worklet(),message=ctx.processor.port.onmessage;
    function send(n){p.scan(new Float32Array(n));ctx.currentTime=p.scope.currentFrame/48000;for(const data of p.messages.splice(0))message({data});}
    send(512);
    if(mode==='reset'){p.scope.currentFrame=0;send(128);}
    else if(mode==='long'){p.scope.currentFrame+=5000;send(128);}
    else if(mode==='repeated'){for(let i=0;i<4;i++){p.scan(null);send(32);}}
    else message({data:{type:mode==='unknown'?'other':'gap',startFrame:mode==='replay'?0:512,expectedFrame:514,endFrame:513}});
    assert.equal(processed,mode==='repeated'?4:1);assert.equal(errors.length,1);
    assert.match(errors[0],mode==='unknown'?/Invalid input batch/:/expected frame .*observed frame .*gap/);
    message({data:{}});assert.equal(errors.length,1);assert.equal(ctx.state,'closed');assert.ok(f.tracks[0].stopped);assert.equal(f.timers.size,0);
  }
});
test('mono averages first pair or uses sole channel; left/right are isolated with no output path',async()=>{
  for(const [channel,count,indices] of [['mono',2,[0,1]],['mono',1,[0]],['left',2,[0]],['right',2,[1]]]) {
    const f=fixture();f.input.channel=channel;f.w.localStorage.getItem=()=>JSON.stringify({deviceId:f.input.id,channel});
    const take=f.media.getUserMedia;f.media.getUserMedia=async c=>{const s=await take(c);s.getAudioTracks()[0].getSettings=()=>({deviceId:f.input.id,channelCount:count});return s;};
    const run=audioRun(f.w,f.input,0,{fail:assert.fail});await flush();const [source,split,processor]=f.nodes;
    assert.deepEqual(source.connections,[[split]]);assert.deepEqual(split.connections.map(([g,i])=>{assert.equal(g.gain.value,1/indices.length);assert.deepEqual(g.connections,[[processor]]);return i;}),indices);
    assert.equal(processor.options.numberOfOutputs,0);assert.deepEqual(processor.connections,[]);run.stop();
  }
});
test('unsupported worklets, module failures and cancelled module loads never acquire input',async()=>{
  for(const mode of ['missing','rejected','late resolve','late reject']) {
    const f=fixture();let failure,settle;
    if(mode==='missing')delete f.w.AudioWorkletNode;
    else f.loader.addModule=()=>new Promise((resolve,reject)=>{settle=mode==='late resolve'?resolve:()=>reject(Error('404'));});
    const run=audioRun(f.w,f.input,0,{fail:e=>failure=e});await flush();
    if(mode.startsWith('late'))run.stop();settle?.();await flush();
    if(mode.startsWith('late'))assert.equal(failure,undefined);else assert.match(failure.message,mode==='missing'?/AudioWorklet unavailable/:/load.*404/);
    assert.equal(f.contexts[0].state,'closed');assert.equal(f.requests.length,0);assert.equal(f.nodes.length,0);assert.equal(f.timers.size,0);
  }
});
test('processor failure or missing heartbeat discards capture once and ignores queued events',async()=>{
  for(const mode of ['processorerror','timeout','stale batch']) {
    const f=fixture(),errors=[];audioRun(f.w,f.input,0,{ready:assert.fail,fail:e=>errors.push(e.message)});await flush();
    const ctx=f.contexts[0],p=ctx.processor,message=p.port.onmessage,error=p.onprocessorerror, event={data:{startFrame:0,endFrame:512,onsets:[]}};
    ctx.currentTime=.5;if(mode==='processorerror')error();else if(mode==='timeout')[...f.timers.values()][0]();else message(event);
    error();message(event);assert.equal(errors.length,1);assert.match(errors[0],mode==='processorerror'?/processor failed/:/No fresh/);
    assert.ok(f.tracks[0].stopped && p.port.closed);assert.equal(ctx.state,'closed');assert.equal(p.onprocessorerror,null);assert.ok(f.nodes.every(n=>n.disconnected));assert.equal(f.timers.size,0);
  }
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
test('scored Electron acquisition and playing exclude the native diagnostic',async()=>{
  const f=fixture(),els={};f.w.feedBackDesktop=desktop();let polls=0;
  f.w.feedBackDesktop.audio.isAudioRunning=()=>{polls++;return true;};
  const doc=f.w.document=new EventTarget();doc.getElementById=()=>new EventTarget();
  f.w.feedBack={workingTuning:{get:()=>({instrument:'guitar'})},on(){},off(){},navigate(){}};
  const session=mount(f.w,{querySelector:s=>els[s.slice(9,-2)]={}});await flush();
  els.tempo.valueAsNumber=80;els.delay.valueAsNumber=0;els.mode.value='course';
  els.start.onclick();assert.equal(els.check.disabled,true);els.check.onclick();await flush();
  els.check.onclick();assert.equal(polls,0);assert.equal(f.requests.length,1);assert.equal(f.tracks[0].stopped,undefined);
  els.pause.onclick();assert.ok(f.tracks[0].stopped);assert.equal(els.check.disabled,false);session.stop();
});
test('host spec registers once, immediate and queued',()=>{
  const script=fs.readFileSync(require.resolve('../game'),'utf8');for(const immediate of [true,false]) {
    const regs=[],window=immediate?{feedBackMinigames:{register:s=>regs.push(s)}}:{};
    for(let i=0;i<2;i++)vm.runInNewContext(script,{window});const specs=immediate?regs:window.__feedBackMinigamesPending;
    assert.deepEqual(Array.from(specs,s=>s.id),['rhythm_recall']);
  }
});
