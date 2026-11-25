const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mount} = require('../game');
const flush = () => new Promise(resolve=>setImmediate(resolve));

function stage(rate=48000) {
  let now=0, n=0, flashes=0, media=0, writes=0, frames=0;
  const intervals=new Map(), timeouts=new Map(), fields={}, listeners=new Map(), doc=new EventTarget();
  const quit=new EventTarget(); doc.getElementById=()=>quit;
  const device={input:'Test interface',inputType:'ASIO',sampleRate:rate}, source={id:0,deviceKey:0,inputChannel:5,active:true};
  let signal=()=>0;
  const audio={getCurrentDevice:async()=>device,listSources:async()=>[source],isAudioRunning:async()=>true,
    getRawAudioFrame:async size=>{frames++;return Float32Array.from({length:size},(_,i)=>signal(Math.floor(now*rate/1000)-size+i));}};
  const w={document:doc,feedBackDesktop:{isDesktop:true,audio},performance:{now:()=>now},
    feedBack:{workingTuning:{get:()=>({instrument:'guitar'})},navigate(){},on:(k,f)=>listeners.set(k,f),off:k=>listeners.delete(k)},
    navigator:{mediaDevices:{getUserMedia(){media++;throw Error('Unexpected capture');},enumerateDevices:async()=>[]}},
    localStorage:{getItem:()=>null,setItem(){writes++;}},setInterval:f=>(intervals.set(++n,f),n),clearInterval:i=>intervals.delete(i),
    setTimeout:f=>(timeouts.set(++n,f),n),clearTimeout:i=>timeouts.delete(i)};
  const session=mount(w,{querySelector:s=>fields[s.slice(9,-2)]={animate(){flashes++;return {cancel(){}};}}});
  return {audio,source,device,doc,quit,listeners,fields,intervals,timeouts,session,w,
    get frames(){return frames;},get flashes(){return flashes;},get sideEffects(){return [writes,media];},
    signal(fn){signal=fn;},async tick(ms=25){now+=ms;await Promise.all(Array.from(intervals.values(),f=>f()));},
    async start(){fields.check.onclick();await flush();}};
}

test('native source 0 only: slow plucks, overlapping and duplicate snapshots, silence and a ninth pick',async()=>{
  for(const [rate,freq] of [[44100,41.2],[48000,329.6],[96000,82.4]]) {
    const f=stage(rate), times=Array.from({length:9},(_,i)=>.1+i*.45+(i===8?1:0));
    f.signal(sample=>{const t=sample/rate, onset=times.findLast(x=>x<=t), age=t-onset;
      return age<.3 ? .18*Math.exp(-12*age)*Math.sin(2*Math.PI*freq*age):0;});
    await f.start();assert.equal(f.fields.scored.hidden,true);assert.match(f.fields.checkStatus.textContent,/Listening/);
    f.fields.start.onclick();f.fields.check.onclick();assert.equal(f.intervals.size,1);
    for(let i=1;i<=200;i++){await f.tick();await f.tick(0);if(i===170)assert.equal(f.fields.count.textContent,'8 detected picks');}
    assert.equal(f.fields.count.textContent,'9 detected picks');assert.equal(f.flashes,9);assert.deepEqual(f.sideEffects,[0,0]);
    assert.equal(f.fields.scored.hidden,true);f.fields.endCheck.onclick();assert.equal(f.intervals.size,0);assert.equal(f.fields.scored.hidden,false);
    f.session.stop();
  }
});

test('pending native PCM is serialized and discarded on reset, pause, stop, navigation or setup change',async()=>{
  for(const action of ['zero','pause','endCheck','hidden','setup','navigate','quit','teardown']) {
    const f=stage();await f.start();let settle, calls=0;
    f.audio.getRawAudioFrame=size=>{calls++;return new Promise(r=>settle=()=>r(new Float32Array(size).fill(.3)));};
    const pending=f.tick();await flush();await f.tick();assert.equal(calls,1);
    if(action==='hidden'){f.doc.hidden=true;f.doc.dispatchEvent(new Event('visibilitychange'));}
    else if(action==='setup')f.listeners.get('working-tuning-changed')();
    else if(action==='navigate')f.listeners.get('screen:changing')({detail:{id:'home'}});
    else if(action==='quit')f.quit.dispatchEvent(new Event('click'));
    else if(action==='teardown')f.session.stop();else f.fields[action].onclick();
    settle();await pending;assert.equal(f.flashes,0);assert.deepEqual(f.sideEffects,[0,0]);assert.equal(f.timeouts.size,0);
    if(action==='zero'){
      f.audio.getRawAudioFrame=async n=>new Float32Array(n).fill(.3);await f.tick();assert.equal(f.flashes,0);assert.match(f.fields.checkStatus.textContent,/Listening/);
    }else assert.equal(f.intervals.size,0);
    f.session.stop();
  }
});

test('stopped engine, missing bridge, invalid frames, stalled IPC and device changes stop native check without fallback',async()=>{
  for(const mode of ['stopped','missing','empty','format','NaN','rate','inactive','channel','unplug','reject','timeout']) {
    const f=stage();await f.start();
    if(mode==='stopped')f.audio.isAudioRunning=async()=>false;
    if(mode==='missing')delete f.audio.getRawAudioFrame;
    if(mode==='empty')f.audio.getRawAudioFrame=async()=>new Float32Array();
    if(mode==='format')f.audio.getRawAudioFrame=async n=>new Uint8Array(n);
    if(mode==='NaN')f.audio.getRawAudioFrame=async n=>new Float32Array(n).fill(NaN);
    if(mode==='rate')f.device.sampleRate=0;
    if(mode==='inactive')f.source.active=false;
    if(mode==='channel')f.source.inputChannel++;
    if(mode==='unplug')f.device.input='';
    if(mode==='reject')f.audio.isAudioRunning=async()=>{throw Error('private driver detail');};
    if(mode==='timeout'){
      let reject;f.audio.isAudioRunning=()=>new Promise((_,r)=>reject=r);
      const pending=f.tick();await flush();[...f.timeouts.values()][0]();reject(Error());await pending;
    }else await f.tick(501);
    assert.equal(f.fields.scored.hidden,false,mode);assert.match(f.fields.checkStatus.textContent,/stopped|unavailable|invalid|changed|failed|not respond/);
    assert.equal(f.intervals.size+f.timeouts.size,0);assert.deepEqual(f.sideEffects,[0,0]);
    if(mode==='stopped')assert.equal(f.frames,1);f.session.stop();
  }
});
