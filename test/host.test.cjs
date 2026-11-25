// Optional read-only integration: real JS loader + real Minigames SDK. Only
// the DOM, registry HTTP responses, timer and navigation boundaries are fakes.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname,'..'), host = process.env.FEEDBACK_HOST_DIR || path.resolve(root,'../../got-feedBack/feedBack');
const loader = path.join(host,'static/js/plugin-loader.js'), manifest = require('../plugin.json');
test('actual FeedBack loader, stage start, captured Quit and non-scoring teardown', {skip:fs.existsSync(loader)?false:'Set FEEDBACK_HOST_DIR to a host checkout'},async()=>{
  const window = new EventTarget(), document = new EventTarget(), events = new EventTarget(), links=[], requests=[], scripts=[], routes=[];
  const event = (id,detail) => Object.assign(new Event(id),{detail});
  const nodes = new Map();
  class Element extends EventTarget {
    constructor(){super();this.children=[];this.dataset={};this.hidden=false;this.classList={add:()=>this.hidden=true,remove:()=>this.hidden=false};this.fields=new Map();}
    set innerHTML(v){this.content=v;this.children=[];}
    appendChild(el){this.children.push(el);}
    querySelector(k){if(!this.fields.has(k))this.fields.set(k,new Element());return this.fields.get(k);}
  }
  for(const id of ['nav-plugins','mobile-nav-plugins','mg-stage','mg-stage-title','mg-stage-quit','mg-stage-instrument','mg-stage-body','mg-stage-hud']) nodes.set(id,new Element());
  document.getElementById = id=>nodes.get(id)||null; document.createElement=()=>new Element();
  document.querySelectorAll=()=>[]; document.head={querySelector:()=>null,appendChild:el=>links.push(el)};
  const read=p=>fs.readFileSync(p,'utf8');
  document.body={appendChild(el){scripts.push(el.src);vm.runInContext(read(path.join(root,manifest.script)),ctx);el.onload();}};
  window.document=document; window.localStorage={getItem:()=>null}; window.navigator={mediaDevices:{}};
  window.feedBack={on:(...a)=>events.addEventListener(...a),off:(...a)=>events.removeEventListener(...a),workingTuning:{get:()=>({instrument:'guitar'})},navigate(id){routes.push(id);for(const k of ['screen:changing','screen:changed'])events.dispatchEvent(event(k,{id}));}};
  const ctx=vm.createContext({window,document,Node:Element,CustomEvent:Event,console,performance,setTimeout:()=>1,fetch:async(url,options)=>{
    requests.push([url,options?.method||'GET']);return {ok:true,json:async()=>url==='/api/plugins'?[{...manifest,has_script:!!manifest.script,has_styles:!!manifest.styles}]:{minigames:[{...manifest.minigame,plugin_id:manifest.id}]}};
  }});
  // Adapt ES-module keywords for a dependency-free VM; viz picker is not
  // used by loadPlugins(). Execute the complete loader function unchanged.
  vm.runInContext(read(loader).replace(/^import .*?;$/m,'').replace(/^export /gm,''),ctx);
  await ctx.loadPlugins(); await ctx.loadPlugins();
  const prefix='/api/plugins/'+manifest.id+'/';assert.deepEqual(scripts,[prefix+'screen.js?v='+manifest.version]);
  assert.deepEqual(links.map(l=>l.href),[prefix+manifest.styles+'?v='+manifest.version]);assert.ok(read(path.join(root,manifest.styles)).includes('.rr-game'));
  vm.runInContext(read(path.join(host,'plugins/minigames/screen.js')),ctx);
  const sdk=window.feedBackMinigames;assert.deepEqual(Array.from(sdk.listRegistered(),s=>s.id),[manifest.id]);
  await sdk.start(manifest.id,{modifiers:{}});const body=nodes.get('mg-stage-body'),quit=nodes.get('mg-stage-quit');
  assert.match(body.children[0].content,/Rhythm Recall/);assert.equal(typeof quit.onclick,'function');
  // EventTarget doesn't implement DOM onclick; model that bubble handler.
  quit.addEventListener('click',()=>quit.onclick());quit.dispatchEvent(new Event('click',{cancelable:true}));await new Promise(r=>setImmediate(r));
  assert.deepEqual(routes,['home']);assert.equal(body.children.length,0);assert.ok(nodes.get('mg-stage').hidden);
  assert.deepEqual(requests,[['/api/plugins','GET'],['/api/plugins','GET'],['/api/plugins/minigames/registry','GET']]);
});
