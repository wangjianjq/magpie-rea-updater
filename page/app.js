const $ = (id) => document.getElementById(id)
let opts = {}
let timer

function ago(iso) {
  if (!iso) return "—"
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  const d = new Date(iso).toLocaleString()
  return m < 1 ? `刚刚 (${d})` : m < 90 ? `${m} 分钟前 (${d})` : `${Math.round(m / 60)} 小时前 (${d})`
}
function isBusy() {
  const r = opts.request, s = opts.status || {}
  return !!(r && r.id && r.id !== s.handledId && Date.now() - Number(r.at || 0) < 3 * 60000)
}
function render() {
  const s = opts.status || {}
  const busy = isBusy()
  $("installed").textContent = s.installed ? "v" + s.installed : "—"
  $("latest").textContent = s.latest ? "v" + s.latest : "—"
  $("checked").textContent = ago(s.checkedAt)
  const st = $("state")
  st.className = ""
  if (busy) st.textContent = "正在检查…"
  else if (!s.checkedAt) st.textContent = "尚未检查"
  else {
    st.textContent = s.msg || s.result || ""
    st.className = s.result === "up-to-date" || s.result === "updated" ? "ok" : s.result === "deferred" || s.result === "locked" ? "warn" : "err"
  }
  $("checkBtn").disabled = busy
  $("interval").disabled = busy
  $("interval").value = String([1, 6, 12, 24].includes(Number(opts.intervalHours)) ? opts.intervalHours : 6)
  $("busy").textContent = busy ? "处理中，Magpie 会重载插件，稍候…" : ""
  $("log").textContent = (s.log || []).join("\n")
}
async function load() {
  try { opts = (await magpie.options.get()) || {} } catch (e) { $("state").textContent = "读取失败: " + e.message }
  render()
  clearTimeout(timer)
  timer = setTimeout(load, isBusy() ? 2500 : 10000)
}
$("checkBtn").onclick = async () => {
  opts = (await magpie.options.get()) || {}
  opts = await magpie.options.set({ ...opts, request: { id: String(Date.now()), action: "check", at: Date.now() } })
  render()
  clearTimeout(timer)
  timer = setTimeout(load, 2500)
}
$("interval").onchange = async () => {
  opts = (await magpie.options.get()) || {}
  opts = await magpie.options.set({ ...opts, intervalHours: Number($("interval").value) })
  render()
}
magpie.ready.then(load)
