"use strict";
const token = location.hash.slice(1);
history.replaceState(null, "", "/");
const choose = document.getElementById("choose"), stop = document.getElementById("stop"), video = document.getElementById("preview"), status = document.getElementById("status");
let stream, timer, epoch = 0, selecting = false, alive = true, captureId = "";
const headers = { Authorization: "Bearer " + token };
async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(5000), cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error("Местная сессия закрыта. Вернись в плагин и заново открой выбор экрана.");
  return response;
}
function end(message = "Показ остановлен.", notify = true) {
  epoch++; clearTimeout(timer);
  stream?.getTracks().forEach(track => track.stop()); stream = undefined;
  video.srcObject = null; video.hidden = true; stop.disabled = true; choose.disabled = !alive;
  status.textContent = message;
  const previous = captureId; captureId = "";
  if (notify && previous) void request("/stop", { method: "POST", headers: { "X-Capture-Id": previous }, keepalive: true }).catch(() => {});
}
async function sendFrame(captureEpoch) {
  if (!stream || captureEpoch !== epoch) return;
  try {
    if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
      const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d"); if (!context) throw new Error("Браузер не смог подготовить снимок.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .7));
      if (!stream || captureEpoch !== epoch) return;
      if (!blob || blob.size > 2200000) throw new Error("Не удалось подготовить снимок выбранного окна.");
      await request("/frame", { method: "POST", headers: { "Content-Type": "image/jpeg", "X-Capture-Id": captureId }, body: blob });
      if (captureEpoch !== epoch) return;
      status.textContent = "Экран выбран. Вернись в Astra и нажми «Показывать экран». Эта вкладка должна оставаться открытой.";
    }
    timer = setTimeout(() => void sendFrame(captureEpoch), 1000);
  } catch (error) { if (captureEpoch === epoch) { alive = false; end(error.message); } }
}
choose.onclick = async () => {
  if (selecting || !alive) return;
  if (!navigator.mediaDevices?.getDisplayMedia) { status.textContent = "Открой эту страницу в Edge, Chrome или Firefox: нужен браузер с выбором экрана."; return; }
  selecting = true; end("Выбери окно или экран в окне браузера."); choose.disabled = true;
  const captureEpoch = epoch;
  try {
    // Keep this in the click handler: browser permission requires user activation.
    const selected = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 2, max: 5 } }, audio: false });
    if (!alive || captureEpoch !== epoch) { selected.getTracks().forEach(track => track.stop()); return; }
    stream = selected;
    selected.getVideoTracks()[0].addEventListener("ended", () => end("Показ остановлен в браузере."), { once: true });
    const session = await (await request("/begin", { method: "POST" })).json();
    if (!alive || captureEpoch !== epoch) { void request("/stop", { method: "POST", headers: { "X-Capture-Id": session.captureId } }).catch(() => {}); return; }
    captureId = session.captureId;
    video.srcObject = selected; video.hidden = false; stop.disabled = false;
    await video.play();
    void sendFrame(captureEpoch);
  } catch (error) {
    end(error.name === "NotAllowedError" ? "Разрешение не получено. Можно снова нажать «Выбрать окно или экран»." : "Браузер не смог начать показ. Повтори выбор в Edge, Chrome или Firefox.");
  } finally { selecting = false; choose.disabled = !alive; }
};
stop.onclick = () => end();
window.addEventListener("pagehide", () => { alive = false; end("Страница закрыта."); });
const heartbeat = setInterval(() => { void request("/status").catch(() => { alive = false; clearInterval(heartbeat); end("Показ завершён в Astra. Открой выбор экрана в плагине заново.", false); }); }, 2000);
if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { alive = false; choose.disabled = true; status.textContent = "Открой эту страницу по кнопке выбора экрана в плагине Astra."; }
