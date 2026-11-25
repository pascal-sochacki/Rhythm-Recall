// SPDX-License-Identifier: MIT
(function (win) {
  'use strict';

  // Each motif is one beat on a sixteenth grid. An empty beat is intentional.
  const motifs = {
    Q: ['Downbeat', [0], 4], E: ['Eighth pair', [0, 2], 2],
    O: ['Offbeat eighth', [2], 2], S: ['Four sixteenths', [0, 1, 2, 3], 1],
    G: ['Gallop', [0, 2, 3], 1], R: ['Quarter rest', [], 4],
    A: ['Anticipation', [3], 1]
  };
  // A shared quarter-note lead-in makes the next example schedulable before
  // the final corrected input buffer of the preceding reply has arrived.
  const patterns = [
    ['Four on the floor', 'QQQQQQQQ'], ['Backbeat breaks', 'QQRQQQRQ'],
    ['Eighth-note drive', 'QEEEQEEE'], ['Offbeat chops', 'QOOOQOOO'],
    ['Galloping eights', 'QGQGQGQG'], ['Sixteenth-note rolls', 'QSRSQSSQ'],
    ['Tresillo (3–3–2)', 'QORQQORQ'], ['Beat anticipation', 'QRAOQEAQ']
  ].map(([name, beats]) => ({name, beats}));
  const ensure = (ok, message) => { if (!ok) throw new Error(message); };
  const blank = () => ({attempts:0, hits:0, misses:0, extras:0, absMs:0, signedMs:0});
  const accuracy = s => s.hits / (s.hits + s.misses + s.extras || 1);
  const mastered = history => history.slice(-3).filter(x => x >= 0.8).length >= 2;
  function add(target, from) { for (const key of Object.keys(blank())) target[key] += from[key]; }

  function score(pattern, beat, attacks) {
    const expected = [], parts = {}, total = blank();
    [...pattern.beats].forEach((id, i) => {
      const m = motifs[id]; (parts[id] ||= blank()).attempts++;
      for (const tick of m[1]) expected.push({id, t:(i + tick / 4) * beat, unit:m[2] * beat / 4});
    });
    // Nonoverlapping windows, including transitions to a finer subdivision.
    // Pick closest candidate rather than letting an earlier extra steal a hit.
    for (let i = 0; i < expected.length; i++) {
      const e = expected[i];
      e.window = Math.min(.095, .44 * Math.min(e.unit, e.t - (expected[i-1]?.t ?? -Infinity), (expected[i+1]?.t ?? Infinity) - e.t));
    }
    for (const t of attacks) {
      if (!(t >= 0 && t < beat * 8)) continue;
      const e = expected.find(n => Math.abs(t - n.t) <= n.window);
      if (!e) parts[pattern.beats[Math.floor(t / beat)]].extras++;
      else if (e.hit === undefined) e.hit = t;
      else {
        const extra = Math.abs(t - e.t) < Math.abs(e.hit - e.t) ? e.hit : t;
        if (extra !== t) e.hit = t;
        parts[pattern.beats[Math.floor(extra / beat)]].extras++;
      }
    }
    for (const e of expected) {
      const s = parts[e.id];
      if (e.hit === undefined) s.misses++;
      else { s.hits++; s.signedMs += (e.hit - e.t) * 1000; s.absMs += Math.abs(e.hit - e.t) * 1000; }
    }
    for (const s of Object.values(parts)) add(total, s);
    total.attempts = 1;
    return {total, parts};
  }

  const storageKey = 'rhythm_recall.progress.v1';
  function load(storage) {
    const db = JSON.parse(storage.getItem(storageKey) ?? '{}');
    ensure(db && typeof db === 'object' && !Array.isArray(db), 'Invalid local progress.');
    for (const [key, s] of Object.entries(db)) {
      ensure(/^(guitar|bass):/.test(key) && s && Object.keys(blank()).every(k => Number.isFinite(s[k]) && (k === 'signedMs' || s[k] >= 0) && (k.endsWith('Ms') || Number.isSafeInteger(s[k]))), 'Invalid local progress.');
    }
    return db;
  }
  function weakest(db, instrument, exclude) {
    const stats = p => db[instrument + ':' + p.name];
    return patterns.filter(p => p !== exclude && stats(p)?.attempts).sort((a,b) => accuracy(stats(a)) - accuracy(stats(b)) || stats(a).attempts - stats(b).attempts)[0]
      || patterns.find(p => p !== exclude);
  }

  class Transport {
    constructor(start, bpm, pattern, finish) {
      this.start = start; this.beat = 60/bpm; this.pattern = pattern; this.finish = finish;
      this.tick = 0; this.cycle = 0; this.attacks = []; this.recent = [];
    }
    boundary() { return this.start + (this.cycle+1)*16*this.beat; }
    replyStart() { return this.start + (this.cycle*16+8)*this.beat; }
    gap(from, until) {
      // Both intervals are half-open. Allow for roundoff from converting
      // integer frames and applying delay on a different arithmetic path.
      const eps = Number.EPSILON * Math.max(1, this.boundary()) * 4;
      if (from < this.boundary()-eps && until > this.replyStart()+eps) {
        this.invalid = true; this.attacks.length = 0;
      }
      return !!this.invalid;
    }
    receive(t) {
      const offset = t - this.replyStart();
      if (!this.invalid && offset >= 0 && t < this.boundary()) this.attacks.push(offset);
    }
    processed(until) {
      if (until < this.boundary()) return;
      if (this.invalid) { this.invalid = false; this.cycle++; return; }
      const result = score(this.pattern, this.beat, this.attacks);
      this.recent = [...this.recent.slice(-2), accuracy(result.total)];
      const next = this.finish(this.pattern, result, this.recent);
      if (next !== this.pattern) this.recent = [];
      this.pattern = next; this.cycle++; this.attacks = [];
    }
    schedule(now, play) {
      for (;; this.tick++) {
        const time = this.start + this.tick*this.beat/4;
        if (time > now + .1) return;
        ensure(time >= now, 'Audio scheduler fell behind. Partial reply discarded; resume to retry.');
        const cycle = Math.floor(this.tick/64), slot = this.tick%64;
        ensure(cycle <= this.cycle || slot < 4, 'Input timing stalled. Resume to retry.');
        if (slot%4 === 0) play(time, slot%16 === 0 ? 'accent' : 'click');
        if (slot < 32 && motifs[this.pattern.beats[Math.floor(slot/4)]][1].includes(slot%4)) play(time, 'note');
      }
    }
  }

  async function selected(w) {
    const media = w.navigator.mediaDevices;
    ensure(media?.getUserMedia, 'Input capture unavailable. Use HTTPS/localhost and allow input access.');
    if (!w.feedBackDesktop?.isDesktop) {
      const s = JSON.parse(w.localStorage.getItem('slopsmith_notedetect') || '{}');
      ensure(typeof s.deviceId === 'string' && s.deviceId.trim() && !['default','communications'].includes(s.deviceId) && ['mono','left','right'].includes(s.channel), 'Select an explicit device and channel in FeedBack Note Detection settings.');
      return {id:s.deviceId, channel:s.channel};
    }
    const a = w.feedBackDesktop.audio;
    ensure(a?.getCurrentDevice && a.listSources && media.enumerateDevices, 'Desktop input identity unavailable.');
    const [device, sources, list] = await Promise.all([a.getCurrentDevice(), a.listSources(), media.enumerateDevices()]);
    const primary = sources?.find(s => s.id === 0 && s.active && s.deviceKey === 0);
    ensure(device?.input?.trim() && device.inputType && [-1,0,1].includes(primary?.inputChannel), 'Unsupported native input/channel. Select mono or channel 1/2 in FeedBack.');
    const match = list.filter(d => d.kind === 'audioinput' && d.deviceId && !['default','communications'].includes(d.deviceId) && d.label.trim() === device.input.trim());
    ensure(match.length === 1, 'No unique exact-name Electron input. Check permission, duplicate labels or an exclusive native driver.');
    return {id:match[0].deviceId, channel:['mono','left','right'][primary.inputChannel+1], label:match[0].label, driver:device.inputType};
  }

  // One owner per acquisition, allocated synchronously on the user gesture.
  // Late streams are stopped even if the stage disappears during permission.
  function audioRun(w, input, correction, handlers) {
    const ctx = new (w.AudioContext || w.webkitAudioContext)({latencyHint:'interactive'});
    const nodes = new Set(), voices = new Set();
    const own = node => (nodes.add(node), node);
    let dead = false, stream, track, processor, timer, watcher, busy = false, transport, last, arrived;
    const gaps = [], frame = n => Number.isSafeInteger(n) && n >= 0;
    const timing = (expected, observed) => `expected frame ${expected ?? 'unknown'}, observed frame ${observed} (gap ${frame(expected) && frame(observed) ? ((observed-expected)*1000/ctx.sampleRate).toFixed(2)+' ms' : 'unknown'})`;
    const same = async () => ensure(JSON.stringify(await selected(w)) === JSON.stringify(input), 'Selected input changed. Review the new input before resuming.');
    function stop() {
      if (dead) return; dead = true;
      w.clearInterval(timer); w.clearInterval(watcher);
      if (processor) {
        processor.onprocessorerror = processor.port.onmessage = null;
        processor.port.close();
      }
      ctx.onstatechange = null;
      if (track) track.onmute = track.onended = null;
      for (const osc of voices) { osc.onended = null; try { osc.stop(); } catch {} }
      for (const node of nodes) node.disconnect();
      nodes.clear(); voices.clear(); stream?.getTracks().forEach(t => t.stop()); ctx.close().catch(()=>{});
    }
    function fail(e) { if (!dead) { stop(); handlers.fail(e); } }
    function tone(t, kind) {
      const osc = own(ctx.createOscillator()), env = own(ctx.createGain());
      const note = kind === 'note', duration = note ? .085 : .033;
      osc.type = note ? 'triangle' : 'sine'; osc.frequency.value = note ? 220 : kind === 'accent' ? 1500 : 980;
      env.gain.setValueAtTime(.0001,t); env.gain.exponentialRampToValueAtTime(note ? .17 : .10,t+.003);
      env.gain.exponentialRampToValueAtTime(.0001,t+duration);
      osc.connect(env); env.connect(ctx.destination); voices.add(osc);
      osc.onended = () => { voices.delete(osc); osc.disconnect(); env.disconnect(); nodes.delete(osc); nodes.delete(env); };
      osc.start(t); osc.stop(t+duration);
    }
    async function begin() {
      await ctx.resume(); if (dead) return;
      ensure(ctx.audioWorklet?.addModule && w.AudioWorkletNode, 'AudioWorklet unavailable. Use HTTPS/localhost and a supported browser or Desktop version.');
      try { await ctx.audioWorklet.addModule('/api/plugins/rhythm_recall/assets/onset-processor.js?v=0.2.1'); }
      catch (e) { throw new Error(`Could not load Rhythm Recall input processor: ${e.message}`); }
      if (dead) return;
      await same(); if (dead) return;
      const acquired = await w.navigator.mediaDevices.getUserMedia({audio:{deviceId:{exact:input.id}, channelCount:{ideal:2}, echoCancellation:false, noiseSuppression:false, autoGainControl:false}});
      if (dead) { acquired.getTracks().forEach(t => t.stop()); return; }
      stream = acquired; await same(); if (dead) return;
      track = stream.getAudioTracks()[0];
      const settings = track?.getSettings(), channel = ['left','right'].indexOf(input.channel);
      ensure(track?.readyState === 'live' && !track.muted && settings.deviceId === input.id && (!input.driver || track.label.trim() === input.label.trim()), 'Capture did not verify the selected live device.');
      ensure(Number.isInteger(settings.channelCount) && settings.channelCount > Math.max(0,channel), 'Cannot verify selected input channel.');
      const lost = () => fail(new Error('Input muted or disconnected. Check the interface.'));
      track.onmute = track.onended = lost;
      ctx.onstatechange = () => { if (ctx.state !== 'running') fail(new Error('Audio context interrupted.')); };
      ensure(ctx.state === 'running', 'Audio context suspended.');
      const source = own(ctx.createMediaStreamSource(stream)), split = own(ctx.createChannelSplitter(2));
      processor = own(new w.AudioWorkletNode(ctx,'rhythm-recall-onsets',{numberOfInputs:1,numberOfOutputs:0,channelCount:1,channelCountMode:'explicit'}));
      processor.onprocessorerror = () => fail(new Error('Input processor failed. Partial reply discarded; resume to retry.'));
      source.connect(split);
      const channels = channel >= 0 ? [channel] : settings.channelCount === 1 ? [0] : [0,1];
      for (const ch of channels) { const g = own(ctx.createGain()); g.gain.value = 1/channels.length; split.connect(g,ch); g.connect(processor); }
      arrived = ctx.currentTime;
      processor.port.onmessage = ({data}) => {
        if (dead) return;
        try {
          const {type,startFrame,endFrame,expectedFrame,onsets} = data, rate = ctx.sampleRate;
          if (type === 'reset') throw new Error(`Input clock reset: ${timing(expectedFrame,data.observedFrame)}.`);
          if (!frame(startFrame) || !frame(endFrame) || endFrame <= startFrame || (last !== undefined && startFrame !== last))
            throw new Error(`Missing or discontinuous audio frames: ${timing(last,startFrame)}; end frame ${endFrame}.`);
          const now = ctx.currentTime, age = now - endFrame/rate;
          if (age >= .45 || age < -.02) throw new Error(`No fresh input frames: ${timing(endFrame,Math.round(now*rate))}.`);
          const corrected = f => f/rate - correction;
          if (type === 'gap') {
            const detail = timing(expectedFrame,endFrame);
            ensure(frame(expectedFrame) && expectedFrame >= startFrame && expectedFrame-startFrame < 512 && expectedFrame < endFrame && onsets === undefined, `Invalid input gap: ${detail}.`);
            while (gaps.length && endFrame-gaps[0] >= rate) gaps.shift();
            ensure(endFrame-expectedFrame <= rate*.1 && gaps.length < 3, `Long or repeated input gaps: ${detail}.`);
            gaps.push(endFrame); last = endFrame;
            const affected = transport?.gap(corrected(startFrame),corrected(endFrame));
            transport?.processed(corrected(endFrame));
            handlers.gap?.(detail,affected);
            return; // Only classified PCM refreshes the watchdog or starts play.
          }
          const length = endFrame-startFrame;
          ensure(type === undefined && length >= 512 && length%128 === 0 && length <= rate*.45, 'Invalid input batch.');
          ensure(Array.isArray(onsets) && onsets.length <= length/128, 'Invalid input onset count.');
          for (let i=0; i<onsets.length; i++) {
            const f = onsets[i];
            ensure(frame(f) && f >= startFrame && f < endFrame && (f-startFrame)%128 === 0 && (!i || f > onsets[i-1]), 'Invalid input onset frames.');
          }
          arrived = now; last = endFrame;
          if (!transport) transport = handlers.ready(arrived + .18);
          for (const f of onsets) { const t = corrected(f); transport.receive(t); handlers.attack(t); }
          transport.processed(corrected(endFrame));
        } catch (e) { fail(e); }
      };
      timer = w.setInterval(() => {
        if (dead) return;
        try {
          if (ctx.state !== 'running' || ctx.currentTime-arrived >= .45)
            throw new Error(`No fresh input callbacks: ${timing(last ?? Math.round(arrived*ctx.sampleRate),Math.round(ctx.currentTime*ctx.sampleRate))}.`);
          if (transport) { transport.schedule(ctx.currentTime,tone); handlers.display(ctx.currentTime); }
        } catch (e) { fail(e); }
      },20);
      watcher = w.setInterval(async () => {
        if (dead || busy) return; busy = true;
        try { await same(); } catch (e) { fail(e); } finally { busy = false; }
      },350);
    }
    begin().catch(fail); return {stop};
  }

  function describe(s) {
    const pct = s.hits+s.misses+s.extras ? `${Math.round(100*accuracy(s))}%` : 'Clean rests';
    const timing = s.hits ? ` · ${Math.round(s.absMs/s.hits)} ms mean error (${Math.round(s.signedMs/s.hits)} ms signed)` : '';
    return `${pct} · ${s.hits} hit / ${s.misses} missed / ${s.extras} extra${timing}`;
  }
  function mount(w, container) {
    const doc = w.document, host = w.feedBack, quit = doc.getElementById('mg-stage-quit');
    container.innerHTML = `<section class="rr-game"><header><small>EAR TRAINING &nbsp; / &nbsp; 4/4</small><h2>Rhythm Recall</h2><p>Listen for two bars, then echo for two. Pick any note. Keep the pulse.</p></header>
      <div class="rr-controls"><label>Tempo (BPM) <input data-r="tempo" type="number" min="40" max="150" value="80"></label>
      <label>Input delay (ms) <input data-r="delay" type="number" min="-100" max="180" value="0"></label>
      <label>Practice <select data-r="mode"><option value="course">Pattern course</option><option value="weak">Weak patterns first</option></select></label></div>
      <p data-r="input"></p><button data-r="start">Prepare input</button> <button data-r="pause" disabled>Pause</button> <button data-r="leave">Leave</button>
      <p role="status" data-r="status"></p><article><small data-r="phase">READY</small><h3 data-r="pattern"></h3><pre data-r="grid"></pre><p>Each group is one beat: 1 e &amp; a. ● = attack, · = no attack.</p><p data-r="pulse"></p><p data-r="signal"></p></article>
      <h3>Last reply</h3><p data-r="result">No completed reply yet.</p><details><summary>Local practice history</summary><pre data-r="history"></pre></details><p data-r="storage"></p></section>`;
    const el = id => container.querySelector(`[data-r="${id}"]`);
    const ui = Object.fromEntries('tempo delay mode input start pause leave status phase pattern grid pulse signal result history storage'.split(' ').map(k=>[k,el(k)]));
    const text = (k,v) => { if (ui[k].textContent !== v) ui[k].textContent = v; };
    let alive = true, gen = 0, owner, confirmed, running = false, paused = false, db = {}, writable = true;
    let instrument, pattern = patterns[0], recent = [], transport, beatLabel, lastAttack, activeMode;
    try { db = load(w.localStorage); } catch { writable = false; text('storage','Local progress unavailable or damaged. Practicing in memory only.'); }
    function history() {
      const line = (key,label,unit) => { const s = db[instrument+':'+key]; return s ? `${label}: ${s.attempts} ${unit} · ${describe(s)}` : `${label}: not tried`; };
      const used = [...new Set(patterns.flatMap(p=>[...p.beats]))];
      text('history',[instrument?.toUpperCase() || 'SELECT AN INSTRUMENT', ...patterns.map(p=>line(p.name,p.name,'replies')), '', 'RECURRING BEATS', ...used.map(id=>line(id,motifs[id][0],'beats'))].join('\n'));
    }
    function showPattern() {
      text('pattern',pattern.name);
      const beats = [...pattern.beats].map(id=>Array.from({length:4},(_,i)=>motifs[id][1].includes(i)?'●':'·').join(''));
      text('grid',`Bar 1   ${beats.slice(0,4).join('  ')}\nBar 2   ${beats.slice(4).join('  ')}`);
    }
    function resetAudio() {
      gen++; owner?.stop(); owner = transport = confirmed = null; running = false; beatLabel = lastAttack = null;
      ui.pause.disabled = true; ui.start.disabled = false; text('start','Review input'); text('pulse',''); text('signal','Not listening');
    }
    function pause(message) {
      paused = true; resetAudio(); text('phase','PAUSED'); text('status',message); text('start','Review input to resume');
    }
    function fail(e) { pause(`${e.message || e} Incomplete reply discarded.`); }
    function leave(e) { e?.preventDefault(); e?.stopImmediatePropagation(); stop(); host?.navigate?.('home'); }
    function stop() {
      if (!alive) return; alive = false; resetAudio();
      quit?.removeEventListener('click',leave,true); doc.removeEventListener('visibilitychange',visibility);
      host?.off?.('screen:changing',changing); host?.off?.('working-tuning-changed',changed);
      ui.start.onclick = ui.pause.onclick = ui.leave.onclick = null;
    }
    function visibility() { if (doc.hidden) pause('Backgrounded. Resume from the example.'); }
    function changing(e) { if (e.detail?.id !== 'plugin-minigames') stop(); }
    function changed() { pause('Host setup changed. Review the selected input.'); }
    function getInstrument() {
      ensure(host?.workingTuning?.get && host?.on && host?.off && host?.navigate && quit,'Required FeedBack host lifecycle unavailable.');
      const value = host.workingTuning.get()?.instrument;
      ensure(['guitar','bass'].includes(value),'Select guitar or bass in FeedBack first.'); return value;
    }
    async function prepare() {
      resetAudio(); const g = gen; ui.start.disabled = true; text('input','Checking FeedBack input…');
      try {
        const inst = getInstrument(); const input = await selected(w); if (!alive || g !== gen) return;
        ensure(inst === getInstrument(),'Instrument changed during setup.');
        if (inst !== instrument) { paused = false; recent = []; pattern = patterns[0]; }
        instrument = inst; confirmed = input; history(); showPattern();
        text('input',`${inst} · ${input.driver ? `${input.label} (${input.driver} → Electron)` : `Browser input ${input.id}`} · ${input.channel === 'mono' ? 'mono (first pair)' : input.channel}`);
        text('status','Use headphones or clean DI. Confirm this input to start.'); text('phase','READY');
        text('start',input.driver ? 'Use Electron capture & play' : 'Use selected input & play'); ui.start.disabled = false;
        ui.tempo.disabled = ui.delay.disabled = ui.mode.disabled = false;
      } catch (e) { if (alive && g === gen) { fail(e); text('input','No verified input.'); } }
    }
    function start() {
      if (!alive || running) return; if (!confirmed) { prepare(); return; }
      const bpm = ui.tempo.valueAsNumber, delay = ui.delay.valueAsNumber, mode = ui.mode.value;
      if (!Number.isInteger(bpm) || bpm < 40 || bpm > 150 || !Number.isFinite(delay) || delay < -100 || delay > 180) { text('status','Choose 40–150 whole BPM and an input delay from −100 to +180 ms.'); return; }
      const g = gen;
      try {
        ensure(!doc.hidden && instrument === getInstrument(),'Stage hidden or instrument changed.');
        if (!paused || mode !== activeMode) { pattern = mode === 'weak' ? weakest(db,instrument) : patterns[0]; recent = []; }
        activeMode = mode; paused = false; running = true; showPattern();
        ui.start.disabled = ui.tempo.disabled = ui.delay.disabled = ui.mode.disabled = true; ui.pause.disabled = false;
        text('status','Opening verified input…');
        owner = audioRun(w,confirmed,delay/1000,{
          ready(at) {
            transport = new Transport(at,bpm,pattern,finish); transport.recent = recent;
            text('status','Advance with ≥80% on two of the last three replies.'); text('signal','Listening for attacks…'); return transport;
          }, attack(t) { lastAttack = t; },
          gap(detail,affected) {
            lastAttack = null;
            text('status',`Input gap: ${detail}. ${affected ? 'Reply not scored. The next example repeats the same pattern.' : 'Outside the reply; practice continues.'}`);
          },
          display(now) {
            const b = Math.floor((now-transport.start)/transport.beat);
            text('signal',lastAttack !== null && now-lastAttack < .2 ? 'Attack detected' : 'Listening for attacks…');
            if (b === beatLabel) return; beatLabel = b;
            text('phase',b < 0 ? 'GET READY' : b%16 < 8 ? 'LISTEN · EXAMPLE' : 'PLAY · YOUR REPLY');
            text('pulse',b < 0 ? 'Starting on beat one…' : `Bar ${Math.floor(b%8/4)+1} / 2   ·   Beat ${b%4+1} / 4   ·   ${bpm} BPM`);
          }, fail(e) { if (alive && gen === g) fail(e); }
        });
      } catch (e) { fail(e); }
    }
    function finish(p, result, scores) {
      text('status','Advance with ≥80% on two of the last three replies.');
      for (const [k,s] of Object.entries({[p.name]:result.total,...result.parts})) add(db[instrument+':'+k] ||= blank(),s);
      if (writable) try { w.localStorage.setItem(storageKey,JSON.stringify(db)); } catch { writable = false; text('storage','Save failed. New progress is in memory only.'); }
      const pass = mastered(scores);
      text('result',`${p.name} · ${describe(result.total)}. Recent: ${scores.map(x=>Math.round(x*100)+'%').join(' / ')}. ${pass ? 'Mastered — next pattern.' : 'Listen and try again.'}`);
      recent = pass ? [] : scores;
      if (pass) pattern = activeMode === 'weak' ? weakest(db,instrument,p) : patterns[(patterns.indexOf(p)+1)%patterns.length];
      showPattern(); history(); return pattern;
    }
    quit?.addEventListener('click',leave,true); doc.addEventListener('visibilitychange',visibility);
    host?.on?.('screen:changing',changing); host?.on?.('working-tuning-changed',changed);
    ui.start.onclick = start; ui.leave.onclick = leave; ui.pause.onclick = () => pause('Paused. Resume restarts the two-bar example.');
    prepare(); return {stop};
  }
  if (typeof module === 'object' && module.exports) { module.exports = {motifs,patterns,score,accuracy,mastered,Transport,selected,audioRun,mount,weakest,load}; return; }
  if (win.__rhythmRecallLoaded) return; win.__rhythmRecallLoaded = true;
  let stage;
  const spec = {id:'rhythm_recall',title:'Rhythm Recall',start({container}) { stage?.stop(); stage = mount(win,container); },stop() { stage?.stop(); stage = null; }};
  if (win.feedBackMinigames) win.feedBackMinigames.register(spec);
  else (win.__feedBackMinigamesPending ||= []).push(spec);
})(typeof window !== 'undefined' ? window : globalThis);
