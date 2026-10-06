(function () {
"use strict";
const $ = id => document.getElementById(id);
let snapshot, dirty = false, busy = false, polling = false, noticeError = "";
let participantsKey = "";
const clearSecrets = new Set();
const pickers = [];
let modelConnections = [], currentMusic;
let volumeEditing = false, volumePending = 0, volumeRevision = 0, volumeInstance = "";
function drawPickers() {
  for (const picker of pickers) {
    const signature = JSON.stringify([...picker.select.options].map(o => [o.value, o.textContent]));
    if (signature !== picker.signature) {
      picker.signature = signature; picker.menu.replaceChildren();
      picker.options = [...picker.select.options].map(option => {
        const item = document.createElement("button"); item.type = "button"; item.setAttribute("role", "option"); item.textContent = option.textContent;
        item.onclick = () => { picker.select.value = option.value; picker.select.dispatchEvent(new Event("change", { bubbles: true })); closePickers(); drawPickers(); picker.button.focus(); };
        picker.menu.append(item); return { value: option.value, button: item };
      });
    }
    picker.button.textContent = picker.select.selectedOptions[0]?.textContent || "Выберите";
    for (const option of picker.options) option.button.setAttribute("aria-selected", String(option.value === picker.select.value));
  }
}
function closePickers() { for (const picker of pickers) { picker.menu.hidden = true; picker.button.setAttribute("aria-expanded", "false"); } }
function preparePickers() {
  for (const select of document.querySelectorAll("select")) {
    const container = document.createElement("div"), button = document.createElement("button"), menu = document.createElement("div");
    container.className = "choice"; button.className = "choice-current"; button.type = "button"; button.setAttribute("aria-haspopup", "listbox"); button.setAttribute("aria-expanded", "false");
    const label = document.querySelector('label[for="' + select.id + '"]'); button.setAttribute("aria-label", label?.textContent || select.id);
    menu.className = "choice-menu"; menu.hidden = true; menu.setAttribute("role", "listbox");
    const options = [...select.options].map(option => { const item = document.createElement("button"); item.type = "button"; item.setAttribute("role", "option"); item.textContent = option.textContent; item.onclick = () => { select.value = option.value; select.dispatchEvent(new Event("change", { bubbles: true })); closePickers(); button.setAttribute("aria-expanded", "false"); drawPickers(); button.focus(); }; menu.append(item); return { value: option.value, button: item }; });
    const picker = { select, button, menu, options }; pickers.push(picker); select.hidden = true; select.after(container); container.append(button, menu);
    button.onclick = () => { const opening = menu.hidden; closePickers(); menu.hidden = !opening; button.setAttribute("aria-expanded", String(opening)); if (opening) picker.options.find(v => v.value === select.value)?.button.focus(); };
    container.onkeydown = event => { if (event.key === "Escape") { closePickers(); button.setAttribute("aria-expanded", "false"); button.focus(); } else if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); const current = picker.options.findIndex(v => v.button === document.activeElement); menu.hidden = false; button.setAttribute("aria-expanded", "true"); picker.options[(current + (event.key === "ArrowDown" ? 1 : -1) + picker.options.length) % picker.options.length]?.button.focus(); } };
  }
  document.addEventListener("click", event => { if (!event.target.closest(".choice")) { closePickers(); for (const p of pickers) p.button.setAttribute("aria-expanded", "false"); } }); drawPickers();
}
const labels = { offline: "Отключён", connecting: "Подключение", listening: "Слушает", recognizing: "Распознаёт речь", thinking: "Готовит ответ", speaking: "Говорит" };
async function backend(method, params = {}) {
  const bridgeDeadline = Date.now() + 5000;
  while (!window.astra?.callBackend && Date.now() < bridgeDeadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (!window.astra?.callBackend) throw new Error("Нет связи вкладки с Astra. Выключите и включите плагин, затем откройте вкладку заново.");
  let timer;
  const timeout = method === "state" ? 5000 : method === "start_screen" ? 35000 : ["connect", "use_astra_recognition"].includes(method) ? 110000 : ["models", "test_voice", "use_astra_voice", "discover_discord", "music_play", "music_search"].includes(method) ? 100000 : 15000;
  let result;
  try { result = await Promise.race([window.astra.callBackend(method, params), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Astra не ответила на «" + method + "». Перезапустите плагин. Отправленное действие могло продолжить выполняться.")), timeout); })]); }
  finally { clearTimeout(timer); }
  for (const key of ["resultJson", "result_json"]) if (typeof result?.[key] === "string") { result = result[key]; break; }
  if (typeof result === "string") { try { result = JSON.parse(result); } catch { throw new Error("Плагин вернул неподдерживаемый ответ."); } }
  if (result?.content) {
    const text = result.content.find(item => item.type === "text")?.text;
    if (text) { try { result = JSON.parse(text); } catch { result = { error: text }; } }
  }
  if (result?.ok === false || result?.error && !result?.settings) throw new Error(result.error || "Не удалось выполнить действие.");
  return result;
}
function notice(message = "") { noticeError = message; for (const id of ["notice", "actionFeedback"]) { $(id).textContent = message; $(id).hidden = !message; } }
function primaryContrast() {
  const first = document.querySelector("button.primary"); if (!first) return;
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1; const context = canvas.getContext("2d"); if (!context) return;
  context.fillStyle = getComputedStyle(first).backgroundColor; context.fillRect(0, 0, 1, 1); const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  document.documentElement.style.setProperty("--discord-button-foreground", (r * .2126 + g * .7152 + b * .0722) > 160 ? "#18181c" : "#ffffff");
}
function fill(settings) {
  for (const [name, value] of Object.entries(settings)) {
    const element = $(name); if (!element) continue;
    if (element.type === "checkbox") element.checked = value === true;
    else if (name === "musicVolume") continue; // Live volume is drawn from music state, not saved defaults.
    else element.value = Array.isArray(value) ? value.join("\n") : String(value ?? "");
  }
  for (const name of ["botToken", "llmApiKey", "sttApiKey", "ttsApiKey", "googleApiKey"]) {
    $(name).value = ""; $(name).placeholder = settings[name + "Saved"] ? "Сохранён. Пусто — оставить текущий" : name === "botToken" ? "Токен Discord-бота" : "Ключ API, если нужен";
  }
  clearSecrets.clear(); drawPickers(); providerPanels();
  const choice = settings.llmUseAstra ? "astra" : settings.llmProviderId || "manual";
  if (![...$("llmProviderChoice").options].some(o => o.value === choice)) { const option = document.createElement("option"); option.value = choice; option.textContent = choice; $("llmProviderChoice").append(option); }
  $("llmProviderChoice").value = choice; drawPickers();
  $("musicVolumeValue").textContent = $("musicVolume").value + " / 10";
}
function formValues() {
  const values = {};
  for (const element of $("settingsForm").elements) {
    if (!element.name) continue;
    values[element.name] = element.name === "musicVolume" ? Number(element.value) * 10 : element.type === "checkbox" ? element.checked : element.type === "number" ? Number(element.value) : element.value;
  }
  for (const name of clearSecrets) values["clear_" + name] = true;
  if (!values.llmUseAstra) { try { values.llmKeyScope = JSON.stringify([values.llmProviderId, new URL(values.llmBaseUrl).href.replace(/\/+$/, "")]); } catch {} }
  return values;
}
function providerPanels() {
  $("sttApi").hidden = $("sttEngine").value !== "api"; $("sttVosk").hidden = $("sttEngine").value !== "vosk";
  $("sttWhisper").hidden = $("sttEngine").value !== "whisper";
  $("sttGoogle").hidden = $("sttEngine").value !== "google";
  $("googleConsent").hidden = !["google", "whisper"].includes($("sttEngine").value);
  $("sttFollow").hidden = $("sttFollowHelp").hidden = !["google", "whisper"].includes($("sttEngine").value);
  $("whisperModelPath").readOnly = $("sttUseAstra").checked;
  for (const id of ["llmBaseUrl", "llmModel"]) $(id).readOnly = $("llmUseAstra").checked;
  $("personalityHelp").textContent = "Описание личности из настроек Astra передаётся выбранной модели: " + ($("llmBaseUrl").value || "адрес не задан") + ". Изменения характера подхватываются перед каждой репликой. При смене облачного сервера проверьте адрес и сохраните разрешение заново. Если описание пустое, используется обычный характер бота.";
  $("llmKeyHelp").textContent = "Ключи вводятся здесь один раз и хранятся зашифрованными отдельно для каждого провайдера и адреса API. При переключении подключения его ключ возвращается автоматически. Пустое поле сохраняет прежний ключ этого подключения.";
  $("ttsApi").hidden = $("ttsEngine").value !== "api"; $("ttsWindows").hidden = $("ttsEngine").value !== "windows";
  $("ttsSupertonic").hidden = $("ttsEngine").value !== "supertonic";
}
async function save() {
  const result = await backend("save", formValues());
  hideScreenPreview();
  fill(result.settings); dirty = false; $("saveHint").textContent = "Настройки сохранены"; return result;
}
async function action(button, operation) {
  if (busy) { notice("Дождитесь завершения текущего действия. Вкладки и поля настроек остаются доступны."); return; }
  busy = true; button.disabled = true; notice(); $("saveHint").textContent = "Выполняется действие…";
  try { await operation(); }
  catch (error) { notice(error.message); }
  finally { busy = false; button.disabled = false; $("saveHint").textContent = dirty ? "Есть несохранённые изменения" : "Настройки хранятся на этом ПК"; await refresh(); }
}
function render(state) {
  snapshot = state;
  if (!dirty && !document.activeElement?.closest("#settingsForm")) fill(state.settings);
  $("connectionBadge").textContent = labels[state.phase] || "Отключён";
  $("connectionBadge").classList.toggle("live", state.connected);
  $("channelTitle").textContent = state.channelName ? "# " + state.channelName : "Выберите голосовой канал";
  $("status").textContent = state.status;
  $("connect").textContent = state.connected ? "Выйти из канала" : "Войти в канал";
  $("connect").disabled = busy || state.phase === "connecting";
  $("stop").disabled = !state.connected;
  $("testVoice").disabled = busy || !state.connected;
  $("quickAstra").disabled = busy;
  const music = state.music || {};
  $("musicTitle").textContent = music.title || currentMusic?.title || "Трансляция не запущена";
  $("musicArtist").textContent = music.artist || currentMusic?.artist || "";
  $("musicStatus").textContent = music.error || (music.loading ? "Готовим музыку для Discord…" : music.following ? music.paused ? "Музыка в Discord на паузе" : music.playing ? "Музыка звучит в Discord · голосовые ответы остаются доступны" : "Готовим следующий трек…" : "Выберите музыку для Discord.");
  $("musicStart").disabled = busy || !state.connected;
  $("musicPause").disabled = busy || music.loading || !music.following;
  $("musicPause").textContent = music.paused ? "Продолжить" : "Пауза";
  $("musicStop").disabled = !music.following && !music.loading;
  for (const id of ["musicNext", "musicPrevious"]) $(id).disabled = busy || music.loading || !music.following;
  for (const id of ["musicWave", "musicLibrary"]) $(id).disabled = busy || !state.connected;
  if (music.volumeInstance && music.volumeInstance !== volumeInstance) {
    volumeInstance = music.volumeInstance; volumeRevision = 0;
  }
  if (!volumeEditing && !volumePending && Number.isFinite(music.volume) && (music.volumeRevision ?? 0) >= volumeRevision) {
    volumeRevision = music.volumeRevision ?? 0;
    $("musicVolume").value = music.volume / 10; $("musicVolumeValue").textContent = (music.volume / 10) + " / 10";
  }
  const showingScreen = state.screen?.active === true;
  $("screenStatus").textContent = showingScreen ? "Показ экрана включён для разрешённых аккаунтов" + (state.screen.lastSentAt ? " · последний снимок " + new Date(state.screen.lastSentAt).toLocaleTimeString("ru-RU") : "") : "Показ экрана выключен";
  $("screenStatus").closest(".screen-bar").classList.toggle("active", showingScreen);
  $("stopScreen").hidden = !showingScreen && !state.screen?.prepared;
  $("screenDisplay").value = state.screen?.ready ? "Окно или экран выбран в браузере" : "Экран ещё не выбран";
  $("screens").disabled = busy || !state.connected;
  $("previewScreen").disabled = busy || !state.screen?.ready;
  if (!state.screen?.ready) hideScreenPreview();
  if (!state.screen?.prepared) { $("screenPickerLink").hidden = true; $("openScreenPicker").removeAttribute("href"); hideScreenPreview(); }
  $("startScreen").disabled = busy || !state.connected || showingScreen;
  $("participantCount").textContent = String(state.participants.length);
  $("emptyParticipants").hidden = state.participants.length > 0;
  const nextParticipantsKey = JSON.stringify(state.participants);
  if (nextParticipantsKey !== participantsKey) {
    participantsKey = nextParticipantsKey;
    $("participants").replaceChildren();
    for (const person of state.participants) {
    const li = document.createElement("li"), copy = document.createElement("div"), title = document.createElement("strong"), id = document.createElement("span");
    copy.className = "person-copy"; title.textContent = person.name; id.textContent = person.id; copy.append(title, id); li.append(copy);
    if (person.allowed) { const badge = document.createElement("span"); badge.className = "person-allowed"; badge.textContent = "Доступ к ПК"; li.append(badge); }
    else { const button = document.createElement("button"); button.type = "button"; button.textContent = "Разрешить"; button.setAttribute("aria-label", "Добавить " + person.name + " в список доступа к ПК"); button.onclick = () => { const list = $("allowedUserIds").value.split(/[\s,;]+/).filter(Boolean); if (!list.includes(person.id)) list.push(person.id); $("allowedUserIds").value = list.join("\n"); markDirty(); selectTab("access"); }; li.append(button); }
      $("participants").append(li);
    }
  }
  $("approval").hidden = !state.pending;
  if (state.pending) { $("pendingCommand").textContent = state.pending.command; $("commandSpeaker").textContent = "Аккаунт " + state.pending.userId; }
  $("commandResultSection").hidden = !state.commandResult && !state.commandBusy;
  $("commandResult").textContent = state.commandBusy ? "Astra обрабатывает команду…" : state.commandResult;
  $("lastHeard").textContent = state.lastHeard || "Разговор ещё не начался.";
  $("lastAnswer").textContent = state.lastAnswer || ""; $("lastAnswer").hidden = !state.lastAnswer;
  $("updates").replaceChildren();
  for (const item of state.updates.slice(0, 5)) { const li = document.createElement("li"), time = document.createElement("time"), text = document.createElement("span"); time.textContent = new Date(item.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); text.textContent = item.text; li.classList.toggle("error", item.error); li.append(time, text); $("updates").append(li); }
  if (state.localSetup) { $("setupLocal").disabled = state.localSetup.running || busy; $("setupStatus").textContent = state.localSetup.status || "Создаст отдельное окружение и скачает русскую модель, около 45 МБ."; }
  if (state.whisperSetup) { $("setupWhisper").disabled = state.whisperSetup.running || busy; $("astraRecognition").disabled = state.whisperSetup.running || busy; $("whisperSetupStatus").textContent = state.whisperSetup.status || "Установит движок Whisper в отдельное окружение. Модель Astra повторно не скачивается."; }
  if (state.error && !noticeError) notice(state.error);
  primaryContrast();
}
async function refresh() {
  if (polling || document.hidden) return; polling = true;
  try { render(await backend("state")); }
  catch (error) { notice(error.message); }
  finally { polling = false; }
}
function markDirty() { dirty = true; $("saveHint").textContent = "Есть несохранённые изменения"; }
function selectTab(name, focus = true) {
  for (const tab of document.querySelectorAll("[data-tab]")) { const selected = tab.dataset.tab === name; tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; $("panel-" + tab.dataset.tab).hidden = !selected; if (selected && focus) tab.focus(); }
}
for (const tab of document.querySelectorAll("[data-tab]")) {
  tab.onclick = () => selectTab(tab.dataset.tab);
  tab.onkeydown = event => { const tabs = [...document.querySelectorAll("[data-tab]")], index = tabs.indexOf(tab); let next; if (event.key === "ArrowRight") next = (index + 1) % tabs.length; if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length; if (event.key === "Home") next = 0; if (event.key === "End") next = tabs.length - 1; if (next !== undefined) { event.preventDefault(); selectTab(tabs[next].dataset.tab); } };
}
$("settingsForm").oninput = event => { if (event.target.name && event.target.id !== "musicVolume") markDirty(); };
$("settingsForm").onchange = event => { if (event.target.id === "sttEngine") $("sttUseAstra").checked = false; if (event.target.name && event.target.id !== "musicVolume") markDirty(); providerPanels(); };
$("settingsForm").onsubmit = event => { event.preventDefault(); void action($("save"), save); };
$("connect").onclick = () => action($("connect"), async () => { if (snapshot?.connected) await backend("disconnect"); else { if (dirty) await save(); await backend("connect"); } });
$("stop").onclick = () => action($("stop"), () => backend("stop"));
$("clearHistory").onclick = () => action($("clearHistory"), () => backend("clear_history"));
$("approve").onclick = () => action($("approve"), () => backend("approve", { id: snapshot.pending?.id }));
$("reject").onclick = () => action($("reject"), () => backend("reject", { id: snapshot.pending?.id }));
$("testVoice").onclick = () => action($("testVoice"), async () => { if (dirty) await save(); await backend("test_voice"); });
function hideScreenPreview() { $("screenImage").removeAttribute("src"); $("screenPreview").hidden = true; }
$("hideScreenPreview").onclick = hideScreenPreview;
$("previewScreen").onclick = () => action($("previewScreen"), async () => { if (dirty) await save(); const result = await backend("preview_screen"); $("screenImage").src = result.image; $("screenPreview").hidden = false; });
$("screens").onclick = () => action($("screens"), async () => { if (dirty) await save(); const result = await backend("prepare_screen"); const url = new URL(result.url); if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/") throw new Error("Плагин вернул неверный адрес выбора экрана."); $("openScreenPicker").href = url.href; $("screenPickerLink").hidden = false; if (!result.opened) $("openScreenPicker").focus(); notice(result.opened ? "Окно выбора открывается в браузере. Выберите экран, затем вернитесь и нажмите «Показывать экран»." : "Откройте окно выбора в браузере по ссылке ниже. Разрешите показ, затем вернитесь и нажмите «Показывать экран»."); });
$("startScreen").onclick = () => action($("startScreen"), async () => { if (dirty) await save(); await backend("start_screen"); });
// Stopping screen sharing must remain available while another UI action is busy.
$("stopScreen").onclick = async () => { hideScreenPreview(); try { await backend("stop_screen"); } catch (error) { notice(error.message); } finally { await refresh(); } };
$("voices").onclick = () => action($("voices"), async () => { const result = await backend("voices"); $("voiceNames").replaceChildren(...result.voices.map(v => { const option = document.createElement("option"); option.value = v.name; option.label = v.language; return option; })); notice("Найдено голосов Windows: " + result.voices.length); });
$("models").onclick = () => action($("models"), async () => { if (dirty) await save(); const result = await backend("models"); $("modelNames").replaceChildren(...result.models.map(name => { const option = document.createElement("option"); option.value = name; return option; })); notice("Найдено моделей: " + result.models.length); });
$("setupLocal").onclick = () => action($("setupLocal"), async () => { if (dirty) await save(); await backend("setup_local"); });
$("astraVoice").onclick = () => action($("astraVoice"), async () => { if (dirty) await save(); const result = await backend("use_astra_voice"); hideScreenPreview(); fill(result.settings); dirty = false; notice("Выбран текущий голос Astra: Supertonic «" + result.voice + "»."); });
$("astraRecognition").onclick = () => action($("astraRecognition"), async () => { if (dirty) await save(); const result = await backend("use_astra_recognition"); hideScreenPreview(); fill(result.settings); dirty = false; notice("Выбрано распознавание Astra: «" + result.model + "». Бот будет следовать выбору в Astra."); });
$("astraChat").onclick = () => action($("astraChat"), async () => { if (dirty) await save(); const result = await backend("use_astra_chat_model"); hideScreenPreview(); fill(result.settings); dirty = false; notice(result.keyNotice || "Выбрана модель чата Astra: «" + result.model + "». Адрес и порт взяты из Astra."); if (result.keyNotice) $("llmApiKey").focus(); });
async function loadConnections() {
  const result = await backend("model_connections"); modelConnections = result.connections;
  const selected = $("llmProviderChoice").value;
  $("llmProviderChoice").replaceChildren();
  for (const item of [{ id: "astra", name: "Текущее подключение Astra" }, ...modelConnections, { id: "manual", name: "Свой OpenAI-совместимый сервер" }]) { const option = document.createElement("option"); option.value = item.id; option.textContent = item.name; $("llmProviderChoice").append(option); }
  $("llmProviderChoice").value = [...$("llmProviderChoice").options].some(o => o.value === selected) ? selected : "manual"; drawPickers();
}
$("reloadConnections").onclick = () => action($("reloadConnections"), loadConnections);
$("llmProviderChoice").onchange = () => { const choice = $("llmProviderChoice").value; void action($("reloadConnections"), async () => {
  if (dirty) await save();
  if (choice === "astra") { const result = await backend("use_astra_chat_model"); fill(result.settings); dirty = false; notice(result.keyNotice); return; }
  const selected = modelConnections.find(item => item.id === choice);
  $("llmUseAstra").checked = false; $("llmProviderId").value = choice;
  if (selected) { $("llmBaseUrl").value = selected.llmBaseUrl; $("llmModel").value = selected.llmModel; }
  $("llmApiKey").value = ""; clearSecrets.delete("llmApiKey"); $("llmProviderChoice").value = choice;
  const scope = JSON.stringify([choice, new URL($("llmBaseUrl").value).href.replace(/\/+$/, "")]); $("llmKeyScope").value = scope;
  $("llmApiKey").placeholder = snapshot?.settings.llmSavedConnections?.includes(scope) ? "Ключ этого подключения сохранён" : "Введите ключ этого провайдера";
  markDirty(); providerPanels(); drawPickers();
}); };
$("quickAstra").onclick = () => action($("quickAstra"), async () => {
  if (dirty) await save(); const imported = [], errors = [];
  for (const [method, label] of [["use_astra_chat_model", "чат"], ["use_astra_recognition", "распознавание"], ["use_astra_voice", "голос"]]) {
    notice("Берём из Astra: " + label + "…");
    try { const result = await backend(method); fill(result.settings); dirty = false; imported.push(label); }
    catch (error) { errors.push(label + ": " + error.message); }
  }
  hideScreenPreview(); notice((imported.length ? "Взяты из Astra: " + imported.join(", ") + ". Ключи провайдеров вводятся отдельно один раз." : "") + (errors.length ? "\n" + errors.join("\n") : ""));
});
$("musicCurrent").onclick = () => action($("musicCurrent"), async () => { const result = await backend("music_current"); currentMusic = result.track; notice(currentMusic.track_id ? "Выбран текущий трек Astra Music." : "Сначала выберите музыку в Astra Music."); });
async function musicJob(method, value = {}) {
  const started = await backend(method, value), deadline = Date.now() + 105000;
  while (Date.now() < deadline) {
    const state = await backend("state"), job = state.music?.job; render(state);
    if (job?.id !== started.jobId) throw new Error("Музыкальное действие заменено другим запросом.");
    if (job.status === "failed") throw new Error(job.error || "Не удалось подготовить музыку.");
    if (job.status === "done") return job.result;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Музыкальный сервис долго не отвечает. Остановите музыку и повторите действие.");
}
$("musicStart").onclick = () => action($("musicStart"), async () => { if (dirty) await save(); await musicJob("music_play"); });
$("musicNext").onclick = () => action($("musicNext"), () => musicJob("music_next", { direction: 1 }));
$("musicPrevious").onclick = () => action($("musicPrevious"), () => musicJob("music_next", { direction: -1 }));
$("musicWave").onclick = () => action($("musicWave"), async () => { if (dirty) await save(); await musicJob("music_play", { service: "yandex", mode: "wave" }); });
$("musicLibrary").onclick = () => action($("musicLibrary"), async () => { if (dirty) await save(); await musicJob("music_play", { service: "vk", mode: "library" }); });
$("musicPlaylists").onclick = () => action($("musicPlaylists"), async () => {
  const service = $("musicService").value, result = await musicJob("music_playlists", { service });
  $("musicPlaylistResults").replaceChildren();
  if (!result.playlists?.length) { const empty = document.createElement("p"); empty.className = "help"; empty.textContent = "Плейлисты не найдены."; $("musicPlaylistResults").append(empty); }
  for (const playlist of result.playlists || []) {
    const row = document.createElement("div"), copy = document.createElement("div"), title = document.createElement("strong"), button = document.createElement("button");
    row.className = "track-row"; title.textContent = playlist.title || "Плейлист"; copy.append(title); button.type = "button"; button.textContent = "В Discord";
    button.setAttribute("aria-label", "Включить плейлист " + playlist.title + " в Discord");
    button.onclick = () => action(button, async () => { if (dirty) await save(); await musicJob("music_play", { service, mode: "playlist", playlist_id: playlist.playlist_id }); });
    row.append(copy, button); $("musicPlaylistResults").append(row);
  }
});
$("musicPause").onclick = () => action($("musicPause"), () => backend("music_pause"));
$("musicStop").onclick = async () => { try { await backend("music_stop"); } catch (error) { notice(error.message); } finally { await refresh(); } };
$("musicVolume").onpointerdown = () => { volumeEditing = true; };
window.addEventListener("pointerup", () => { volumeEditing = false; });
window.addEventListener("pointercancel", () => { volumeEditing = false; });
$("musicVolume").onkeydown = event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) volumeEditing = true; };
$("musicVolume").onkeyup = () => { volumeEditing = false; };
$("musicVolume").onblur = () => { volumeEditing = false; };
$("musicVolume").oninput = () => { $("musicVolumeValue").textContent = $("musicVolume").value + " / 10"; };
$("musicVolume").onchange = async () => {
  volumePending++;
  try { const result = await backend("music_volume", { level: Number($("musicVolume").value) }); volumeRevision = Math.max(volumeRevision, result.volumeRevision ?? 0); }
  catch (error) { notice(error.message); }
  finally { volumePending--; await refresh(); }
};
$("musicSearch").onclick = () => action($("musicSearch"), async () => {
  const service = $("musicService").value, result = await musicJob("music_search", { service, query: $("musicQuery").value });
  const tracks = result.tracks || result.items || []; $("musicResults").replaceChildren();
  if (!tracks.length) { const empty = document.createElement("p"); empty.className = "help"; empty.textContent = "Треки не найдены. Попробуйте другое название."; $("musicResults").append(empty); }
  for (const track of tracks) {
    const row = document.createElement("div"), copy = document.createElement("div"), title = document.createElement("strong"), artist = document.createElement("small"), button = document.createElement("button");
    row.className = "track-row"; title.textContent = track.title; artist.textContent = track.artist; copy.append(title, artist); button.type = "button"; button.textContent = "В Discord";
    button.setAttribute("aria-label", "Включить " + track.title + " в Discord"); button.onclick = () => action(button, async () => { if (dirty) await save(); await musicJob("music_play", { service: track.service || service, track_id: track.track_id, title: track.title, artist: track.artist, extra: track.extra || {} }); });
    row.append(copy, button); $("musicResults").append(row);
  }
});
$("setupWhisper").onclick = () => action($("setupWhisper"), async () => { if (dirty) await save(); await backend("setup_whisper"); notice("Подготовка Whisper запущена. Здесь появится её состояние; после завершения настройки применятся автоматически."); });
$("discoverDiscord").onclick = () => action($("discoverDiscord"), async () => {
  if (dirty) await save();
  const result = await backend("discover_discord"); fill(result.settings); dirty = false;
  $("discordDiscovery").hidden = false; $("discordInvite").value = result.inviteUrl;
  for (const [target, field, values] of [["discordGuilds", "guildId", result.guilds], ["discordChannels", "channelId", result.channels]]) {
    $(target).replaceChildren();
    for (const item of values) { const button = document.createElement("button"); button.type = "button"; button.textContent = item.name; button.onclick = () => { $(field).value = item.id; markDirty(); notice(field === "guildId" ? "Сервер выбран. Повторите поиск, чтобы получить его каналы." : "Канал выбран. Сохраните настройки и войдите в канал."); }; $(target).append(button); }
  }
  notice(result.guilds.length ? "Найдены серверы бота. Выберите нужный сервер и голосовой канал." : "Бот создан, но ещё не приглашён на сервер. Используйте ссылку ниже.");
});
for (const button of document.querySelectorAll("[data-clear]")) button.onclick = () => { clearSecrets.add(button.dataset.clear); $(button.dataset.clear).value = ""; $(button.dataset.clear).placeholder = "Будет удалён после сохранения"; markDirty(); };
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
preparePickers();
primaryContrast();
window.astra?.onThemeChange?.(primaryContrast);
fill({ silenceMs: 800, maxUtteranceSecs: 20, windowsRate: 0, supertonicSpeed: 1.1, sttEngine: "api", ttsEngine: "windows", ttsPython: "python", supertonicVoice: "F4", sttBaseUrl: "https://api.openai.com/v1", sttModel: "whisper-1", sttPython: "python", ttsBaseUrl: "https://api.openai.com/v1", ttsModel: "tts-1", ttsVoice: "alloy", llmBaseUrl: "http://127.0.0.1:1234/v1", addressMode: "all", wakeWord: "Астра", commandPhrase: "Астра выполни", bargeIn: true, confirmCommands: true });
void refresh(); void loadConnections().catch(error => notice(error.message)); setInterval(refresh, 1500);
window.addEventListener("error", event => notice("Ошибка интерфейса: " + (event.message || "обновите вкладку")));
})();
