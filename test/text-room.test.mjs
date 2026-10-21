import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const project = resolve(import.meta.dirname, '..');
mkdirSync(join(project, '.tmp-tests'), { recursive: true });
const temporary = mkdtempSync(join(project, '.tmp-tests', 'text-'));
process.env.DVOICE_DATA_DIR = temporary;
const core = require('./artifact/plugin.cjs');
const guild = '111111111111111111', channel = '222222222222222222', guest = '333333333333333333', other = '444444444444444444';
let sequence = 0;
const settings = () => core.normalizeSettings({guildId:guild, textChannelId:channel, textEnabled:true, textMusicEnabled:true, textSummonEnabled:true, textChatEnabled:true});
after(() => { assert.ok(temporary.startsWith(project + sep)); rmSync(temporary, {recursive:true,force:true}); });
function harness(overrides = {}) {
  let s = settings(), now = 10000;
  const replies = [], calls = [];
  const actions = {
    join: async (m,valid) => { assert.ok(valid()); calls.push(['join',m.userId]); return 'Я в канале'; },
    leave: async (m,valid) => { assert.ok(valid()); calls.push(['leave',m.userId]); return 'Вышла из канала'; },
    volume: async (change,m,valid) => { assert.ok(valid()); calls.push(['volume',change,m.userId]); return 'Громкость изменена'; },
    control: async (action,m,valid) => { assert.ok(valid()); calls.push(['control',action,m.userId]); return 'Выполнено'; },
    play: async (selection,m,valid) => { assert.ok(valid()); calls.push(['play',selection,m.userId]); return 'Включаю'; },
    search: async (query,service) => { calls.push(['search',query,service]); return [{service,track_id:'abc',title:'Song',artist:'Artist'},{service,track_id:'def',title:'Another'}]; },
    chat: async messages => { calls.push(['chat',messages]); return 'Ответ'; }, error: e => e.message,
    ...overrides,
  };
  const folder=join(temporary,String(++sequence));
  const room = new core.TextRoom(() => s, actions, folder, () => now);
  const message = (content, extra = {}) => ({ id:String(++sequence), userId:guest, guildId:guild, channelId:channel, content, mentioned:false, replyToBot:false, reply:async text => { replies.push(text); return String(++sequence); }, ...extra });
  return {room, folder, actions, replies, calls, message, now:()=>now, settings:()=>s, set:value=>{s={...s,...value};}, tick:(n=3000)=>{now+=n;}};
}
test('summon accepts comma, punctuation, custom wake word and mention, but not an incidental quote', () => {
  for (const text of ['Астра, зайди ко мне','Астра зайди ко мне','АСТРА: зайди ко мне!']) assert.equal(core.parseTextCommand(text,settings()).command.kind,'join');
  assert.equal(core.parseTextCommand('зайди ко мне',settings(),true).command.kind,'join');
  assert.equal(core.parseTextCommand('кто-то сказал Астра зайди ко мне',settings()).command,undefined);
  assert.equal(core.parseTextCommand('Соня зайди ко мне',{...settings(),wakeWord:'Соня'}).command.kind,'join');
});
test('leave commands accept addressed variants and never interpret casual conversation as an exit',()=>{
  for(const text of ['Астра, выйди из канала','Астра выйди из канала','Астра покинь голосовой канал','!leave']) assert.equal(core.parseTextCommand(text,settings()).command.kind,'leave');
  assert.equal(core.parseTextCommand('выйди из канала',settings(),true).command.kind,'leave');
  assert.equal(core.parseTextCommand('выйди из канала',settings()).command,undefined);
});
test('public leave is independent from music ordering and has its own setting',async()=>{
  const h=harness();h.set({textMusicEnabled:false});await h.room.receive(h.message('!leave'));assert.deepEqual(h.calls.map(c=>c[0]),['leave']);
  h.tick();h.set({publicVoiceLeaveEnabled:false});await h.room.receive(h.message('Астра выйди из канала'));assert.equal(h.calls.length,1);assert.match(h.replies.at(-1),/отключил/);
});

test('text volume changes the actual Discord mixer and UI state instead of asking the model',async()=>{
  const bridge=new core.VoiceBridge();bridge.settings=settings();
  const levels=[];
  bridge.transport={connected:true,musicVolume:v=>levels.push(v),musicStats:()=>({})};
  // DiscordMusic retains the original transport, so replace only its mixer sink.
  bridge.music.transport.musicVolume=v=>levels.push(v);
  const h=harness({volume:(change,_m,valid)=>bridge.publicVolume(change,valid),chat:async()=>assert.fail('Volume must not reach the model')});
  for(const [command,expected] of [['Астра громкость 5',50],['Астра, сделай громкость на пять',50],['!volume 25%',25],['Астра громче',35],['Астра тише',25],['Астра громкость 0',0]]) {
    await h.room.receive(h.message(command));h.tick();
    assert.equal(bridge.music.state().volume,expected);assert.equal(levels.at(-1),expected);
    assert.match(h.replies.at(-1),new RegExp(`${expected/10} из 10`));
  }
  assert.equal(bridge.music.state().volumeRevision,6);assert.deepEqual(bridge.settings.allowedUserIds,[]);
  h.set({textMusicEnabled:false});await h.room.receive(h.message('Астра громкость 9'));assert.equal(levels.length,6);assert.match(h.replies.at(-1),/отключил/);
});

test('invalid volume, disconnected voice, cancelled requests and radio shifts never report volume success',async()=>{
  const h=harness();
  for(const command of ['Астра громкость 15','Астра громкость -1','!volume','!volume NaN']) {
    await h.room.receive(h.message(command));h.tick();assert.match(h.replies.at(-1),/от 0 до 10/);
  }
  assert.equal(h.calls.length,0);
  const bridge=new core.VoiceBridge();bridge.settings=settings();
  await assert.rejects(bridge.publicVolume({level:5},()=>true),/не в голосовом/);
  bridge.transport={connected:true};
  await assert.rejects(bridge.publicVolume({level:5},()=>false),/отменено/);
  bridge.radioStarting=true;await assert.rejects(bridge.publicVolume({level:5},()=>true),/смена/);
  bridge.radioStarting=false;bridge.radioShift={active:{name:'Эфир',ends_at:Date.now()/1000+60}};
  await assert.rejects(bridge.publicVolume({level:5},()=>true),/Идёт смена/);
});

test('music transport phrases are commands, while quotes and ordinary conversation stay conversation',()=>{
  const variants={pause:['!pause','Астра пауза','Астра, поставь музыку на паузу'],resume:['!resume','!continue','Астра продолжи музыку','Астра включи музыку'],stop:['!stop','Астра стоп','Астра выключи музыку'],next:['!next','!skip','Астра следующий трек','Астра включи следующую песню'],previous:['!prev','!previous','Астра предыдущий трек','Астра верни предыдущую песню'],current:['!now','!np','Астра что сейчас играет?','Астра какая песня?']};
  for(const [action,phrases] of Object.entries(variants))for(const phrase of phrases)assert.deepEqual(core.parseTextCommand(phrase,settings()).command,{kind:'control',action},phrase);
  assert.equal(core.parseTextCommand('пауза',settings(),true).command.action,'pause');
  assert.equal(core.parseTextCommand('Соня продолжи музыку',{...settings(),wakeWord:'Соня'}).command.action,'resume');
  for(const phrase of ['пауза','я сказал Астра следующий трек','Астра почему эта песня хорошая?'])assert.equal(core.parseTextCommand(phrase,settings()).command,undefined,phrase);
  for(const phrase of ['!next 100','!stop компьютер'])assert.equal(core.parseTextCommand(phrase,settings()).command.kind,'error');
});

test('guests control the Discord player, repeat pause/resume safely and see the real current track',async()=>{
  const bridge=new core.VoiceBridge();bridge.settings=settings();
  const paused=[],stopped=[];
  bridge.transport={connected:true};
  bridge.music.transport={musicStats:()=>({}),pauseMusic:v=>paused.push(v),musicPresence:()=>{},stopMusic:()=>stopped.push(true)};
  bridge.music.following=true;bridge.music.title='Трек';bridge.music.artist='Исполнитель';
  const h=harness({control:(action,_m,valid,signal)=>bridge.publicMusicControl(action,valid,signal),chat:async()=>assert.fail('Music controls must not reach the model')});
  for(const [phrase,isPaused] of [['Астра пауза',true],['!pause',true],['Астра продолжи музыку',false],['!resume',false]]){
    await h.room.receive(h.message(phrase));h.tick();assert.equal(bridge.music.state().paused,isPaused);assert.match(h.replies.at(-1),isPaused?/на паузе/:/Продолжаю/);
  }
  assert.deepEqual(paused,[true,false]);
  await h.room.receive(h.message('Астра что играет?'));h.tick();assert.match(h.replies.at(-1),/Исполнитель — Трек/);
  await h.room.receive(h.message('Астра выключи музыку'));h.tick();assert.equal(bridge.music.state().following,false);assert.equal(stopped.length,1);assert.match(h.replies.at(-1),/остановлена/);
  await h.room.receive(h.message('!resume'));assert.match(h.replies.at(-1),/не включена/);assert.equal(paused.length,2);
  assert.deepEqual(bridge.settings.allowedUserIds,[]);
});

test('disabled music, radio shifts and disconnected voice block public controls without false confirmations',async()=>{
  const h=harness();h.set({textMusicEnabled:false});
  for(const phrase of ['!pause','!resume','!stop','!next','!prev','!now']){await h.room.receive(h.message(phrase));h.tick();assert.match(h.replies.at(-1),/отключил/);}
  assert.equal(h.calls.length,0);
  const bridge=new core.VoiceBridge();bridge.settings=settings();const signal=new AbortController().signal;
  await assert.rejects(bridge.publicMusicControl('pause',()=>true,signal),/не в голосовом/);
  bridge.transport={connected:true};bridge.music.following=true;bridge.music.title='Эфирный трек';
  bridge.radioShift={active:{name:'Эфир',ends_at:Date.now()/1000+60}};
  for(const action of ['pause','resume','stop','next','previous'])await assert.rejects(bridge.publicMusicControl(action,()=>true,signal),/Идёт смена/);
  assert.match(await bridge.publicMusicControl('current',()=>true,signal),/Эфирный трек/);
  await assert.rejects(bridge.publicMusicControl('current',()=>false,signal),/отменена/);
  bridge.radioShift={active:undefined};bridge.radioStarting=true;
  await assert.rejects(bridge.publicMusicControl('next',()=>true,signal),/смена/);
});
test('a send that delivered the answer and then lost its response cannot post a second error reply',async()=>{
  const reports=[];const h=harness({reportError:e=>reports.push(e.message)});let attempts=0;
  await h.room.receive(h.message('Астра ты тут?',{reply:async text=>{attempts++;h.replies.push(text);throw new Error('other side closed');}}));
  assert.equal(attempts,1);assert.deepEqual(h.replies,['Ответ']);assert.deepEqual(reports,['other side closed']);
});
test('model connection failures are reported locally and yield one understandable public message',async()=>{
  const reports=[];const h=harness({chat:async()=>{throw new Error('other side closed');},reportError:e=>reports.push(e.message)});
  await h.room.receive(h.message('Астра ты тут?'));assert.equal(h.replies.length,1);assert.match(h.replies[0],/Соединение прервалось/);assert.ok(!h.replies[0].includes('other side'));assert.deepEqual(reports,['other side closed']);
  assert.match(core.publicTextError('EACCES: private path'),/Подробности/);assert.equal(core.publicTextError('Идёт смена ведущей.'),'Идёт смена ведущей.');
});
test('VK links identify any playlist owner and retain access hash without fetching URLs', () => {
  for (const url of ['https://vk.com/music/playlist/-123_456_abC-9','https://vk.ru/audio_playlist-123_456_abC-9','https://m.vk.com/music?z=audio_playlist-123_456_abC-9','https://vk.com/music/album/-123_456_abC-9']) assert.equal(core.vkPlaylistId(url),'-123:456:abC-9');
  assert.equal(core.vkPlaylistId('https://vk.com/audio_playlist123_456'),'123:456:');
  for (const url of ['http://vk.com/audio_playlist1_2','https://vk.com.evil.test/audio_playlist1_2','https://vk.com@127.0.0.1/audio_playlist1_2','https://evil.test/?z=audio_playlist1_2','https://vk.com:8443/audio_playlist1_2','https://vk.com/audio_playlist1_2/extra','https://vk.com/music?z=audio_playlist1_2%0Acommand']) assert.equal(core.vkPlaylistId(url),undefined,url);
  const parsed=core.parseTextCommand('Астра, включи плейлист https://vk.com/music/playlist/-123_456_HASH',settings());
  assert.deepEqual(parsed.command.selection,{service:'vk',mode:'playlist',playlist_id:'-123:456:HASH'});
});
test('Yandex shared links support UUID, tracking parameters and another owner without using the account library',()=>{
  const uuid='36ee80f9-b411-bcce-9e3a-de5a549fa31a';
  for(const link of [`https://music.yandex.ru/playlists/${uuid}?utm_source=desktop&utm_medium=copy_link`,`https://music.yandex.com/playlists/${uuid.toUpperCase()}/`]) assert.equal(core.yandexPlaylistId(link),uuid);
  assert.equal(core.yandexPlaylistId('https://music.yandex.ru/users/other.owner/playlists/123?utm_source=desktop'),'owner:other.owner:123');
  assert.equal(core.yandexPlaylistId('https://music.yandex.ru/users/user%40yandex.ru/playlists/123'),'owner:user@yandex.ru:123');
  for(const link of [`http://music.yandex.ru/playlists/${uuid}`,`https://music.yandex.ru.evil.test/playlists/${uuid}`,`https://music.yandex.ru@127.0.0.1/playlists/${uuid}`,`https://music.yandex.ru:8443/playlists/${uuid}`,`https://music.yandex.ru/playlists/${uuid}/extra`,'https://music.yandex.ru/users/%2E%2E/playlists/123','https://music.yandex.ru/users/a%2Fb/playlists/123']) assert.equal(core.yandexPlaylistId(link),undefined,link);
  for(const command of [`!playlist https://music.yandex.ru/playlists/${uuid}?utm_source=desktop&utm_medium=copy_link`,`Астра включи плейлист https://music.yandex.ru/playlists/${uuid}`,`<https://music.yandex.ru/playlists/${uuid}>`]) assert.deepEqual(core.parseTextCommand(command,settings()).command.selection,{service:'yandex',mode:'playlist',playlist_id:uuid});
});
test('guest Yandex playlist links reach the player with a Yandex UUID selection',async()=>{
  const h=harness();await h.room.receive(h.message('Астра, включи плейлист https://music.yandex.ru/playlists/36ee80f9-b411-bcce-9e3a-de5a549fa31a?utm_source=desktop&utm_medium=copy_link'));
  assert.deepEqual(h.calls.map(c=>c[0]),['play']);assert.deepEqual(h.calls[0][1],{service:'yandex',mode:'playlist',playlist_id:'36ee80f9-b411-bcce-9e3a-de5a549fa31a'});assert.deepEqual(h.settings().allowedUserIds,[]);
});

test('Spotify playlist links preserve the base62 ID and discard share parameters without URL navigation',()=>{
  const id='5KafKeLCCXVTEywG5NhPPq';
  const link=`https://open.spotify.com/playlist/${id}?si=juUiMZwnShaqCr7GDzYuyw`;
  for(const url of [link,`https://open.spotify.com/intl-ru/playlist/${id}/?si=shared#fragment`])assert.equal(core.spotifyPlaylistId(url),id);
  for(const url of [`http://open.spotify.com/playlist/${id}`,`https://open.spotify.com.evil.test/playlist/${id}`,`https://open.spotify.com@127.0.0.1/playlist/${id}`,`https://open.spotify.com:8443/playlist/${id}`,`https://open.spotify.com/track/${id}`,`https://open.spotify.com/playlist/${id}/extra`,'https://open.spotify.com/playlist/short','https://spotify.link/short'])assert.equal(core.spotifyPlaylistId(url),undefined,url);
  for(const phrase of [`!playlist ${link}`,`!play ${link}`,`Астра, включи плейлист ${link}`,link])assert.deepEqual(core.parseTextCommand(phrase,settings()).command.selection,{service:'spotify',mode:'playlist',playlist_id:id},phrase);
});

test('guest Spotify playlist and personal mix reach their distinct bridge routes with no search or model call',async()=>{
  const bridge=new core.VoiceBridge();bridge.settings=settings();bridge.transport={connected:true};
  const selections=[];bridge.music.request=async(selection,signal)=>{assert.equal(signal.aborted,false);selections.push(selection);return {ok:true};};
  const h=harness({play:(selection,m,valid,signal)=>bridge.publicPlay(selection,m,valid,signal),search:async()=>assert.fail('A playlist or mix must not become a song search'),chat:async()=>assert.fail('A playlist or mix must not reach chat')});
  await h.room.receive(h.message('Астра включи плейлист https://open.spotify.com/playlist/5KafKeLCCXVTEywG5NhPPq?si=shared'));
  assert.match(h.replies.at(-1),/плейлист Spotify по ссылке/);assert.doesNotMatch(h.replies.at(-1),/VK/);
  for(const phrase of ['!wave spotify','Астра включи мой микс','Астра включи мой микс в Spotify']){h.tick();await h.room.receive(h.message(phrase));assert.match(h.replies.at(-1),/персональный микс Spotify/);}
  assert.deepEqual(selections,[{service:'spotify',mode:'playlist',playlist_id:'5KafKeLCCXVTEywG5NhPPq'},...Array.from({length:3},()=>({service:'spotify',mode:'wave'}))]);
  assert.deepEqual(bridge.settings.allowedUserIds,[]);
  bridge.radioStarting=true;h.tick();await h.room.receive(h.message('!wave spotify'));assert.match(h.replies.at(-1),/смена/);assert.equal(selections.length,4);
});
test('music parser keeps query punctuation, selects providers and accepts waves',()=>{
  assert.deepEqual(core.parseTextCommand('!find AC/DC — Hells Bells в VK',settings()).command,{kind:'search',query:'AC/DC — Hells Bells',service:'vk'});
  assert.equal(core.parseTextCommand('Астра включи волну из Спотифая',settings()).command.selection.service,'spotify');
  for(const phrase of ['!wave spotify','Астра включи мой микс','Астра включи волну из Spotify']) assert.equal(core.parseTextCommand(phrase,settings()).command.selection.service,'spotify');
  assert.equal(core.parseTextCommand('Астра включи мою волну в Яндексе',settings()).command.selection.service,'yandex');
  assert.equal(core.parseTextCommand('!playlist',settings()).command.kind,'error');
});
test('guest music search, personal result selection and external VK playlist never need a PC allowlist',async()=>{
  const h=harness();
  await h.room.receive(h.message('!find Song в Spotify'));assert.equal(h.calls[0][0],'search');assert.match(h.replies[0],/Another/);
  h.tick();await h.room.receive(h.message('!play 2'));assert.equal(h.calls[1][1].track_id,'def');
  h.tick();await h.room.receive(h.message('!play 2',{userId:other}));assert.match(h.replies.at(-1),/Сначала найдите/);
  h.tick();await h.room.receive(h.message('!playlist https://vk.com/music/playlist/-987_654_hash'));
  assert.equal(h.calls.at(-1)[1].playlist_id,'-987:654:hash');assert.equal(h.settings().allowedUserIds.length,0);
});
test('public PC phrase never reaches a privileged action or the model',async()=>{
  const h=harness();await h.room.receive(h.message('Астра, выполни: выключи компьютер'));
  assert.equal(h.calls.length,0);assert.match(h.replies[0],/ПК/);
});
test('wrong server, wrong channel and disabled text are ignored without reading or writing memory',async()=>{
  const h=harness();await h.room.receive(h.message('Астра привет',{guildId:other}));await h.room.receive(h.message('!play Song',{channelId:other}));
  h.set({textEnabled:false});await h.room.receive(h.message('Астра привет'));assert.equal(h.calls.length,0);assert.equal(h.room.state().messages,0);
});
test('incomplete text setup does not block saving drafts or using configured voice',()=>{
  const s=core.normalizeSettings({botToken:'test-token',guildId:guild,channelId:other,textEnabled:true});
  assert.doesNotThrow(()=>core.validateSettings(s));
  assert.match(core.textSetupIssue(s),/ID текстового канала/);
  assert.ok(!core.textSetupIssue(s).includes('токен бота'));
  assert.ok(!core.textSetupIssue(s).includes('ID сервера'));
  assert.throws(()=>core.validateSettings({...s,textChannelId:'not-a-discord-id'}),/Discord ID/);
});
test('incomplete text gateway reports only missing fields and does not attempt login',async()=>{
  let created=0;const s={...settings(),botToken:'saved-token',textChannelId:''};
  const transport=new core.TextDiscord(()=>s,{reset:()=>{},state:()=>({messages:0})},()=>assert.fail('Incomplete setup is a status, not a connection failure'),()=>{created++;throw new Error('Must not create client');});
  await transport.start();assert.equal(created,0);assert.equal(transport.state().online,false);
  assert.match(transport.state().status,/ID текстового канала/);assert.ok(!transport.state().status.includes('токен бота'));
});
test('feature switches independently block music and summon while chat remains usable',async()=>{
  const h=harness();h.set({textMusicEnabled:false,textSummonEnabled:false});
  await h.room.receive(h.message('!play Song'));h.tick();await h.room.receive(h.message('Астра зайди ко мне'));h.tick();await h.room.receive(h.message('Астра привет'));
  assert.deepEqual(h.calls.map(c=>c[0]),['chat']);assert.equal(h.replies.length,3);
});
test('context follows conversation without wake word, ignores unrelated replies, expires and can skip side talk',async()=>{
  let answer='Ответ';const requests=[];const h=harness({chat:async messages=>{requests.push(messages);return answer;}});
  await h.room.receive(h.message('Сообщение между людьми'));assert.equal(requests.length,0);
  await h.room.receive(h.message('Астра расскажи про музыку'));h.tick();await h.room.receive(h.message('А почему?'));
  assert.equal(requests.length,2);assert.ok(requests[1].some(m=>String(m.content).includes('Сообщение между людьми')));
  h.tick();await h.room.receive(h.message('Ответ другому',{replyToOther:true}));assert.equal(requests.length,2);
  h.tick();answer='[SKIP]';await h.room.receive(h.message('Посторонняя реплика'));assert.equal(h.replies.length,2);
  h.tick(181000);await h.room.receive(h.message('Продолжение после паузы'));assert.equal(requests.length,3);
  h.tick();answer='Снова ответ';await h.room.receive(h.message('Продолжение',{replyToBot:true}));assert.equal(h.replies.at(-1),'Снова ответ');
});
test('all-message mode works without address and memory is isolated by channel',async()=>{
  const h=harness();h.set({textChatMode:'all'});await h.room.receive(h.message('Вопрос без имени'));
  assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'chat');
  h.set({textChannelId:other});h.room.reset();h.tick();await h.room.receive(h.message('Новый канал',{channelId:other}));
  assert.ok(!JSON.stringify(h.calls.at(-1)).includes('Вопрос без имени'));
});
test('memory survives restart, is bounded and explicit clearing removes remembered text',async()=>{
  const h=harness();await h.room.receive(h.message('Астра запомни песню Ночной рейс'));h.room.reset();h.room=new core.TextRoom(h.settings,h.actions,h.folder,h.now);h.tick();await h.room.receive(h.message('Без обращения после перезапуска'));
  assert.equal(h.calls.length,1);h.tick();await h.room.receive(h.message('Астра что обсуждали?'));assert.match(JSON.stringify(h.calls.at(-1)),/Ночной рейс/);
  await h.room.clear();assert.equal(h.room.state().messages,0);h.tick();await h.room.receive(h.message('Астра привет'));assert.ok(!JSON.stringify(h.calls.at(-1)).includes('Ночной рейс'));
  for(let i=0;i<70;i++) await h.room.receive(h.message('Обычная реплика '+i));
  assert.equal(h.room.state().messages,60);
});
test('revoking music permission while search runs prevents playback',async()=>{
  let finish;const started=new Promise(r=>{finish=r;});let searching;
  const ready=new Promise(r=>{searching=r;});const h=harness({search:async()=>{searching();await started;return [{service:'vk',track_id:'abc'}];}});
  const pending=h.room.receive(h.message('!play Song'));await ready;h.set({textMusicEnabled:false});h.room.reset();finish();await pending;
  assert.equal(h.calls.length,0);assert.equal(h.replies.length,0);
});
test('clearing memory cancels a generated reply before it can be posted or saved',async()=>{
  let release,started;const ready=new Promise(r=>{started=r;});const pendingAnswer=new Promise(r=>{release=r;});
  const h=harness({chat:async()=>{started();return pendingAnswer;}});
  const pending=h.room.receive(h.message('Астра секретный текст'));await ready;const cleared=h.room.clear();release('Старый ответ');await Promise.all([pending,cleared]);
  assert.equal(h.replies.length,0);assert.equal(h.room.state().messages,0);
});
test('a new message arriving during memory clearing is processed after the clear barrier',async()=>{
  let release,started;const ready=new Promise(r=>{started=r;});const delayed=new Promise(r=>{release=r;});
  let count=0;const h=harness({chat:async()=>{if(++count===1){started();return delayed;}return 'Новый ответ';}});
  const old=h.room.receive(h.message('Астра старый разговор'));await ready;const clear=h.room.clear();h.tick();
  const fresh=h.room.receive(h.message('Астра новый разговор'));release('Не отправлять');await Promise.all([old,clear,fresh]);
  assert.deepEqual(h.replies,['Новый ответ']);assert.equal(h.room.state().messages,2);
});
test('text gateway stays available without voice and filters bot/webhook/foreign messages with safe mentions',async()=>{
  const {Events,GatewayIntentBits,ChannelType}=require('discord.js');const client=new EventEmitter();let ready=false,destroyed=0,options;
  const botId='555555555555555555',received=[],sent=[],errors=[];
  const guildObject={id:guild,members:{fetchMe:async()=>({})}};
  client.user={id:botId};client.isReady=()=>ready;client.login=async()=>{ready=true;client.emit(Events.ClientReady);};client.destroy=()=>{ready=false;destroyed++;};
  client.channels={fetch:async()=>({type:ChannelType.GuildText,guild:guildObject,permissionsFor:()=>({has:()=>true})})};
  const room={reset:()=>{},state:()=>({messages:0}),receive:async message=>{received.push(message);await message.reply('Ответ @everyone');}};
  const s={...settings(),botToken:'test-token'};const transport=new core.TextDiscord(()=>s,room,e=>errors.push(e),value=>{options=value;return client;});
  await transport.start();assert.equal(transport.state().online,true);assert.ok(options.intents.includes(GatewayIntentBits.MessageContent));
  const message={id:'message',author:{id:guest,bot:false},guildId:guild,channelId:channel,content:`<@${botId}> зайди ко мне`,mentions:{users:{has:id=>id===botId,some:()=>false}},channel:{sendTyping:async()=>{}},reply:async value=>{sent.push(value);return {id:'reply'};}};
  for(const patch of [{author:{id:guest,bot:true}},{webhookId:'webhook'},{guildId:other},{channelId:other}])client.emit(Events.MessageCreate,{...message,...patch});
  client.emit(Events.MessageCreate,message);await new Promise(r=>setImmediate(r));
  assert.equal(received.length,1);assert.equal(received[0].content,'зайди ко мне');assert.equal(received[0].mentioned,true);assert.deepEqual(sent[0].allowedMentions,{parse:[],repliedUser:false});assert.deepEqual(errors,[]);
  transport.stop();assert.equal(transport.state().online,false);assert.ok(destroyed>0);
});
test('summoning does not replace a busy channel and does not mutate the PC allowlist or configured channel',async()=>{
  const bridge=new core.VoiceBridge();bridge.settings=settings();bridge.settings.channelId=other;
  bridge.textDiscord.voiceChannelFor=async()=>({id:channel,name:'Музыка'});bridge.transport={connected:true};
  await assert.rejects(bridge.publicJoin({guildId:guild,channelId:channel,userId:guest},()=>true),/занята/);
  assert.deepEqual(bridge.settings.allowedUserIds,[]);assert.equal(bridge.settings.channelId,other);
});

test('a scheduled shift explains its channel and ending time before the generic busy-channel check',async()=>{
  const bridge=new core.VoiceBridge();bridge.settings=settings();bridge.transport={connected:true};
  const scheduled={name:'Радиоэфир Astra',channel_id:other,ends_at:Date.parse('2030-01-01T15:00:00Z')/1000};
  bridge.radioShift.active=scheduled;
  bridge.textDiscord.voiceChannelFor=async()=>assert.fail('A known scheduled shift needs no caller-channel lookup');
  const h=harness({join:(m,valid)=>bridge.publicJoin(m,valid),chat:async()=>assert.fail('Schedule explanations must not reach the model')});
  await h.room.receive(h.message('Астра зайди ко мне'));
  const reply=h.replies.at(-1);
  assert.match(reply,/Идёт смена по расписанию «Радиоэфир Astra»/);assert.ok(reply.includes(`<#${other}>`));
  assert.match(reply,/01\.01.*20:00.*UTC\+5/);assert.match(reply,/До окончания смены перейти/);assert.doesNotMatch(reply,/текущий разговор или эфир/);
  bridge.radioShift.active=undefined;bridge.radioStarting=true;bridge.pendingRadioShift=scheduled;
  h.tick();await h.room.receive(h.message('Астра, зайди ко мне'));
  assert.match(h.replies.at(-1),/Начинается смена по расписанию/);assert.match(h.replies.at(-1),/20:00/);
});

test('a refused summon during a scheduled broadcast cannot disconnect or trigger error-side diagnostics',async()=>{
  const bridge=new core.VoiceBridge();bridge.settings={...settings(),radioScheduleEnabled:true};bridge.diagnostics.stop();
  let disconnects=0,stops=0,reports=0;
  bridge.transport={connected:true,disconnect:()=>{disconnects++;},recovering:false};
  bridge.music={stop:()=>{stops++;}};
  const scheduled={name:'Радиоэфир Astra',channel_id:other,ends_at:Date.now()/1000+7200,run_id:'a'.repeat(32)};
  bridge.radioShift.active=scheduled;
  const h=harness({join:(m,valid)=>bridge.publicJoin(m,valid),reportError:()=>{reports++;}});
  await h.room.receive(h.message('Астра зайди ко мне'));bridge.radioShift.tick();
  assert.equal(disconnects,0);assert.equal(stops,0);assert.equal(reports,0);assert.equal(bridge.radioShift.active,scheduled);assert.equal(bridge.transport.connected,true);
  assert.match(h.replies.at(-1),/Идёт смена по расписанию/);
});

test('a schedule that starts during caller lookup is explained and cannot be bypassed by a summon',async()=>{
  const bridge=new core.VoiceBridge();bridge.settings=settings();bridge.transport={connected:true};
  bridge.textDiscord.voiceChannelFor=async()=>{bridge.radioShift.active={name:'Эфир',channel_id:other,ends_at:Date.parse('2030-01-01T15:00:00Z')/1000};return {id:channel,name:'Другой канал'};};
  await assert.rejects(bridge.publicJoin({userId:guest},()=>true),error=>/по расписанию/.test(error.message)&&/20:00/.test(error.message));
});

test('scheduled announcements send once to the selected text channel and suppress mentions',async()=>{
  const {Events,ChannelType}=require('discord.js'),client=new EventEmitter(),sent=[];
  let s={...settings(),botToken:'test-token'},allowed=true,fetching;
  const destination={type:ChannelType.GuildText,guild:{id:guild,members:{fetchMe:async()=>({})}},permissionsFor:()=>({has:()=>true}),send:async value=>{sent.push(value);}};
  client.user={id:other};client.isReady=()=>true;client.login=async()=>{client.emit(Events.ClientReady);};client.destroy=()=>{};
  client.channels={fetch:async id=>{assert.equal(id,channel);await fetching;return destination;}};
  const text=new core.TextDiscord(()=>s,{reset:()=>{},state:()=>({messages:0})},()=>assert.fail('Unexpected gateway error'),()=>client);
  await text.start();assert.equal(await text.announce('Начала смену @everyone',()=>allowed),true);
  assert.equal(sent.length,1);assert.deepEqual(sent[0].allowedMentions,{parse:[],repliedUser:false});
  let release;fetching=new Promise(resolve=>release=resolve);
  const pending=text.announce('Устаревшая смена',()=>allowed);allowed=false;release();assert.equal(await pending,false);assert.equal(sent.length,1);
  allowed=true;s={...s,textEnabled:false};assert.equal(await text.announce('Не отправлять',()=>allowed),false);
  text.stop();
});

test('a scheduled announcement waits for text reconnection and rechecks the destination after channel lookup',async()=>{
  const {Events,ChannelType}=require('discord.js'),client=new EventEmitter(),sent=[];let ready=true,s={...settings(),botToken:'test-token'};
  client.user={id:other};client.isReady=()=>ready;client.login=async()=>client.emit(Events.ClientReady);client.destroy=()=>{};
  const destination={type:ChannelType.GuildText,guild:{id:guild,members:{fetchMe:async()=>({})}},permissionsFor:()=>({has:()=>true}),send:async value=>sent.push(value)};
  client.channels={fetch:async()=>destination};
  const text=new core.TextDiscord(()=>s,{reset:()=>{},state:()=>({messages:0})},()=>{},()=>client);
  await text.start();ready=false;
  const pending=text.announce('Начало смены',()=>true);assert.equal(sent.length,0);ready=true;client.emit(Events.ClientReady);
  assert.equal(await pending,true);assert.equal(sent.length,1);
  client.channels.fetch=async()=>{s={...s,textChannelId:other};return destination;};
  assert.equal(await text.announce('Не отправлять в устаревший канал',()=>true),false);assert.equal(sent.length,1);text.stop();
});
test('successful summon uses temporary voice destination, rejects a caller who moved and preserves PC checks',async()=>{
  const bridge=new core.VoiceBridge();bridge.settings={...settings(),channelId:other};let current=channel;
  bridge.textDiscord.voiceChannelFor=async()=>({id:current,name:'Музыка'});bridge.transport={connected:false,disconnect:()=>{}};bridge.providers={stop:()=>{}};
  bridge.connect=async valid=>{assert.ok(valid());assert.equal(bridge.effectiveSettings().channelId,channel);};
  assert.match(await bridge.publicJoin({userId:guest},()=>true),/Музыка/);assert.equal(bridge.settings.channelId,other);
  assert.equal(core.authorized(bridge.settings,{userId:guest,guildId:guild,channelId:channel}),false);
  bridge.connect=async()=>{current=other;};await assert.rejects(bridge.publicJoin({userId:guest},()=>true),/сменил канал/);
  assert.equal(bridge.summonedChannelId,'');
});
