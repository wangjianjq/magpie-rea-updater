// rea updater panel (Agents page): shows the rea-agents state. When the window opens (panel loads) and the last
// check is older than 10 minutes it asks the plugin host for a throttled check by writing options.request.
const POLL_MS = 6 * 60 * 60 * 1000
const AUTO_MIN_AGE = 10 * 60 * 1000

function paint(el, o) {
  const s = (o && o.status) || {}
  el.style.cssText = ""
  if (s.pending || s.result === "install-failed") {
    el.textContent = `🟠 rea-agents 有新版本 v${s.latest}（当前 v${s.installed}）：${s.msg || "等待安装"}`
    el.style.color = "#ff5a1f"
    el.style.fontWeight = "700"
  } else if (s.result === "check-failed") {
    el.textContent = `rea 更新检查失败（保持 v${s.installed}）：${s.msg}`
  } else if (s.checkedAt) {
    el.textContent = `rea-agents 已是最新（v${s.installed}）`
    el.style.opacity = "0.65"
  } else {
    el.textContent = "rea 更新检查：尚未检查。"
  }
}
async function maybeAuto(o) {
  const s = (o && o.status) || {}
  const r = o && o.request
  const busy = r && r.id && r.id !== s.handledId && Date.now() - Number(r.at || 0) < 10 * 60000
  const age = Date.now() - (s.checkedAt ? Date.parse(s.checkedAt) : 0)
  if (busy || age < AUTO_MIN_AGE) return
  await magpie.options.set({ ...o, request: { id: String(Date.now()), action: "auto", at: Date.now() } })
}
magpie.ready.then(() => {
  const el = document.getElementById("line")
  let first = true
  const tick = async () => {
    try {
      const o = (await magpie.options.get()) || {}
      paint(el, o)
      if (first) { first = false; await maybeAuto(o) }
    } catch (e) { el.style.cssText = ""; el.textContent = "rea 更新检查：读取失败" }
    setTimeout(tick, POLL_MS)
  }
  tick()
})
