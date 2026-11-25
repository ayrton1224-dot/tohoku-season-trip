"use strict";
// 東北 桜・紅葉の旅。2段階(秋→春)。1つ目の季節(秋)の名所を全部回ると、2つ目(春)の地図に切り替わる。どちらも秋田駅スタート。
// 季節の順番は data.js の STAGES の並び(tools/build_app_data.py の SEASONS)で決まる。
// 画面と歩数の扱いは PJ12_AkitaWalk の app.js をもとにしている。

const NATIVE = typeof Android !== "undefined";
const WEB = window.TOHOKU_WEB === true;     // iPhone等のWeb版: 歩数はヘルスケアを見て手入力
const KEY = "tohoku-season-v2";          // v2: 秋→春の順に変えたので、春→秋のときの記録は引き継がない
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString("ja-JP");

// ---------- ルート(tools/build_app_data.py で作成)と名所 ----------
// ゲーム内換算: 実距離 1km = 150歩。到着歩数は実際の道のりから決める。
const STEPS_PER_KM = 150;
const WORD = { spring: "桜", autumn: "紅葉" };
const SEASON = { spring: "春", autumn: "秋" };
let offset = 0;
STAGES.forEach((st, si) => {
  st.index = si;
  st.offset = offset;                                   // この季節が始まる累計歩数
  st.spots.forEach((sp) => {
    const r = st.route.spots[sp.id];
    Object.assign(sp, { stage: si, km: r.km, lat: r.lat, lon: r.lon, elev: Math.round(r.elev),
      cum: Math.max(100, Math.round(r.km * STEPS_PER_KM / 100) * 100) });
    sp.gcum = st.offset + sp.cum;                       // 旅の最初からの累計歩数
    sp.preArea = sp.pre.replace(/[0-9]+$/, "");
  });
  st.len = st.spots[st.spots.length - 1].cum;           // この季節を歩き切る歩数
  st.last = st.spots[st.spots.length - 1];
  offset += st.len;
});
const TOTAL_STEPS = offset;
const ALL_SPOTS = STAGES.flatMap((st) => st.spots);
const FIRST = STAGES[0], SECOND = STAGES[STAGES.length - 1];
const S1 = SEASON[FIRST.id], S2 = SEASON[SECOND.id];       // "秋", "春"
const BOTH = S1 + "も" + S2;

// ---------- 状態 ----------
// total: 旅の累計歩数 / lastCounter: 前回読んだセンサー値 / history: [時刻, 累計] の履歴
// arrivals: { spotId: { t } } / seen: 到着画面を見た名所 / stage: いま旅している季節(0=1つ目, 1=2つ目)
// ---------- 主人公(メインユーザー) ----------
// 最初に、山女子かたびおじを選ぶ。選んだほうが地図を歩き、ホーム画面で話す。反対側のキャラが名所の紹介役になる。
const CHARA = {
  yama: { name: "山女子", walk: "right", pose: (p) => p, intro: "yamajoshi-left-egao" },
  tabi: { name: "たびおじ", walk: "tabioji-right", pose: (p) => p.replace(/^right/, "tabioji-right"), intro: "tabioji-egao" },
};
const other = (k) => (k === "tabi" ? "yama" : "tabi");
function me() { return CHARA[S.main] || CHARA.yama; }
function applyChara() {
  const m = me(), o = CHARA[other(S.main || "yama")];
  const w = document.querySelector("#map .walker:not(.partner) img");
  if (w) { w.src = "chara/" + m.walk + ".svg"; w.alt = m.name; }
  $("guideImg").alt = m.name;
  const hint = document.querySelector("#map .map-hint");
  if (hint) hint.textContent = "地図を動かしています。「現在地」で" + m.name + "に戻ります";
  $("mImg").src = "chara/" + o.intro + ".svg";
  $("mImg").alt = o.name;
}
function openPick() { $("pick").hidden = false; }

function freshState() {
  return { total: 0, lastCounter: null, startedAt: Date.now(), history: [[Date.now(), 0]],
           arrivals: {}, seen: {}, stage: 0, mockCounter: 0, main: null };
}
let S = load();
function load() {
  try { return Object.assign(freshState(), JSON.parse(localStorage.getItem(KEY))); }
  catch (e) { return freshState(); }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* 保存できなくても動く */ } }

let view = S.stage;                                     // 画面に出している季節(1つ目が終わったあとは1つ目の地図も見返せる)

// その季節の中で歩いた歩数(1つ目の分を超えた歩数は、2つ目の分として持ち越す)
function stageSteps(si, total = S.total) { return Math.max(0, Math.min(STAGES[si].len, total - STAGES[si].offset)); }
// 歩数→地図上の距離。名所の到着歩数は100歩単位に丸めているので、名所と名所の間で比例させて、着いたときにピンの上に来るようにする
function stageKm(si, total = S.total) {
  const st = STAGES[si], s = stageSteps(si, total);
  let c0 = 0, k0 = 0;
  for (const sp of st.spots) {
    if (s <= sp.cum) return k0 + (sp.km - k0) * (s - c0) / (sp.cum - c0 || 1);
    c0 = sp.cum; k0 = sp.km;
  }
  return k0;
}

// ---------- 歩数の取り込み ----------
function readCounter() { return NATIVE ? Android.getStepCounter() : S.mockCounter; }

function sync() {
  if (WEB) return;                         // Web版は手入力(setDaySteps)で進める
  const c = readCounter();
  if (c < 0) { registerArrivals(); return; }   // センサーからまだ値が来ていない(到着画面・切り替え画面の続きだけは出す)
  if (S.lastCounter === null) {
    S.lastCounter = c;                     // 初回は基準だけ決める
  } else {
    const delta = c >= S.lastCounter ? c - S.lastCounter : c;   // 端末再起動でカウンタが戻った場合
    S.lastCounter = c;
    if (delta > 0) {
      S.total += delta;
      S.history.push([Date.now(), S.total]);
      if (S.history.length > 2000) S.history = S.history.slice(-1000);
    }
  }
  save();
  registerArrivals();
  render();
}

// 到着時刻 = 履歴から「累計が cum に達した時刻」を線形補間で推定
function arrivalTime(cum) {
  const h = S.history;
  for (let i = 1; i < h.length; i++) {
    if (h[i][1] >= cum) {
      const [t0, s0] = h[i - 1], [t1, s1] = h[i];
      return s1 === s0 ? t1 : Math.round(t0 + (t1 - t0) * (cum - s0) / (s1 - s0));
    }
  }
  return Date.now();
}

// 到着の登録は、いま旅している季節まで(2つ目の名所は、1つ目を終えて進んでから)
function registerArrivals() {
  for (let si = 0; si <= S.stage; si++) {
    for (const sp of STAGES[si].spots) {
      if (S.total < sp.gcum) break;
      if (!S.arrivals[sp.id]) S.arrivals[sp.id] = { t: arrivalTime(sp.gcum) };
    }
  }
  save();
  showNextArrival();
}

// ---------- 画面: ガイド・次の目的地 ----------
function nextSpot() { return STAGES[S.stage].spots.find((s) => S.total < s.gcum); }
function allDone() { return !!S.seen[STAGES[STAGES.length - 1].last.id]; }

function guideSay() {
  const st = STAGES[S.stage], w = WORD[st.id];
  const n = nextSpot();
  if (!n) {
    if (S.stage < STAGES.length - 1) return ["right-egao", st.title + "を歩き切ったよ! つぎは" + STAGES[S.stage + 1].title + "だね。"];
    return ["right-egao", BOTH + "も歩き切った! 東北の桜と紅葉をぜんぶ回ったあなたは最高の旅人だよ。"];
  }
  const hint = n.preArea + "の" + w + "の名所";
  const prev = st.spots[st.spots.indexOf(n) - 1];
  const remain = n.gcum - S.total;
  const leg = n.cum - (prev ? prev.cum : 0);
  const ratio = 1 - remain / leg;
  const km = stageKm(S.stage);
  if (stageSteps(S.stage) === 0) {
    return S.stage === 0
      ? ["right-wink", "秋田駅からスタート! まずは" + S1 + "の旅。" + hint + "を目指して歩こう。"]
      : ["right-wink", "ここからは" + S2 + "の旅。もう一度、秋田駅から出発だよ。" + hint + "を目指そう。"];
  }
  if (ratio > 0.8) return ["right-odoroki", "もうすぐ" + hint + "! あと" + fmt(remain) + "歩だよ。"];
  const climb = n.elev - MapView.elevAt(km);
  if (ratio > 0.2 && climb > 300) return ["right-komari", "ここからは登りだよ。" + hint + "は標高約" + n.elev + "m。ゆっくり行こう。"];
  if (ratio > 0.2 && climb < -250) return ["right-egao", "下り坂! " + hint + "は標高約" + n.elev + "mだから、歩きやすいよ。"];
  if (ratio > 0.4) return ["right-nattoku", "いい調子! " + hint + "を目指して、あと" + fmt(remain) + "歩だよ。"];
  return ["right-egao", "今日も一歩ずつ。" + hint + "を目指して、あと" + fmt(remain) + "歩。"];
}

function render() {
  $("totalSteps").textContent = fmt(S.total);
  document.body.className = STAGES[view].id;
  $("goalCard").hidden = !allDone();

  // 季節タブ(2つ目は、1つ目を終えるまで選べない)
  document.querySelectorAll(".stage-tab").forEach((b) => {
    const si = Number(b.dataset.stage), st = STAGES[si];
    const locked = si > S.stage;
    const arrived = st.spots.filter((s) => S.arrivals[s.id]).length;
    b.disabled = locked;
    b.classList.toggle("on", si === view);
    b.replaceChildren(document.createTextNode(st.title));
    const sub = document.createElement("span");
    sub.className = "lock";
    sub.textContent = locked ? S1 + "を終えると開く" : arrived + " / " + st.spots.length + " か所";
    b.append(sub);
  });

  // ガイドと次の目的地は、いま旅している季節のもの。MapView は表示中の季節なので、標高は旅している季節を見ているときだけ使う
  const st = STAGES[S.stage], w = WORD[st.id];
  const same = view === S.stage;
  const [pose, text] = same ? guideSay() : ["right-egao", "これは" + STAGES[view].title + "の地図だよ。" +
    (allDone() ? BOTH + "も歩き切ったね。" : "いまは" + st.title + "を歩いているよ。")];
  $("guideImg").src = "chara/" + me().pose(pose) + ".svg";
  $("guideText").textContent = text;

  const n = nextSpot();
  if (n) {
    const prev = st.spots[st.spots.indexOf(n) - 1];
    const base = prev ? prev.gcum : st.offset;
    const pct = Math.min(100, ((S.total - base) / (n.gcum - base)) * 100);
    $("nextLabel").textContent = "次の目的地";
    $("nextName").textContent = n.preArea + "の" + w + "の名所";
    $("barFill").style.width = pct + "%";
    $("nextRemain").textContent = "あと " + fmt(n.gcum - S.total) + " 歩";
    $("nextPct").textContent = Math.floor(pct) + "%";
    const km = stageKm(S.stage);
    $("nextElev").textContent = same
      ? "いまの標高 約" + Math.round(MapView.elevAt(km)) + "m → 目的地 標高 約" + n.elev + "m(あと約" + Math.max(0.1, n.km - km).toFixed(1) + "km)"
      : "目的地 標高 約" + n.elev + "m(あと約" + Math.max(0.1, n.km - km).toFixed(1) + "km)";
  } else {
    const fin = S.stage === STAGES.length - 1;
    $("nextLabel").textContent = fin ? "旅のゴール" : st.title;
    $("nextName").textContent = fin ? S1 + "と" + S2 + "の旅 完了!" : SEASON[st.id] + "の旅 完了!";
    $("barFill").style.width = "100%";
    $("nextRemain").textContent = "";
    $("nextPct").textContent = "100%";
    $("nextElev").textContent = "";
  }
  renderMap();
  renderList();
}

// ---------- 画面: 地図 ----------
function renderMap() {
  const st = STAGES[view];
  const km = stageKm(view);
  const n = view === S.stage ? nextSpot() : null;
  const ids = st.spots.filter((s) => S.arrivals[s.id]).map((s) => s.id);
  MapView.setState(ids, n ? n.id : null);
  MapView.walkTo(km);
  Profile.draw(km, ids);
  MapView.setPartners(mates.filter((m) => m.si === view && CHARA[m.main])
    .map((m) => ({ km: stageKm(view, m.total), img: "chara/" + CHARA[m.main].walk + ".svg", name: m.name })));
  $("mapTitle").textContent = st.title + " のルート(秋田駅スタート)";
  $("listTitle").textContent = st.title + " の名所リスト";
  $("routeNote").textContent = "この季節のルートは全長およそ" + Math.round(st.route.km[st.route.km.length - 1]) +
    "km、" + fmt(st.len) + "歩(1km = " + STEPS_PER_KM + "歩)。" + S1 + "と" + S2 + "の合計は " + fmt(TOTAL_STEPS) + "歩です。";
}

function setView(si) {
  view = si;
  MapView.setRoute(STAGES[si].route, STAGES[si].spots);
  Profile.init({ route: STAGES[si].route, spots: STAGES[si].spots, svg: $("profile") });
  render();
}

// ---------- 画面: リスト ----------
function renderList() {
  const ol = $("list");
  ol.replaceChildren();
  STAGES[view].spots.forEach((sp, i) => {
    const a = S.arrivals[sp.id];
    const li = document.createElement("li");
    li.className = a ? "on" : "off";
    const no = document.createElement("span");
    no.className = "no"; no.textContent = i + 1;
    const meta = document.createElement("div");
    meta.className = "meta";
    const b = document.createElement("b"); b.textContent = a ? sp.name : "？？？";
    const small = document.createElement("small");
    small.textContent = a ? sp.area + "・標高" + sp.elev + "m・" + sp.days[0] + (sp.days.length > 1 ? " ほか" : "") : fmt(sp.cum) + "歩で到着";
    meta.append(b, small);
    li.append(no, meta);
    if (a) {
      if (sp.photos.length) { const t = document.createElement("img"); t.className = "thumb"; t.src = "photos/" + sp.photos[0].f; t.alt = ""; li.append(t); }
      li.addEventListener("click", () => openSpot(sp, false));
    }
    ol.append(li);
  });
}

// ---------- 到着ポップアップ ----------
let current = null;

function showNextArrival() {
  if (current || !$("pick").hidden || !$("stageClear").hidden || !$("finale").hidden) return;
  const sp = ALL_SPOTS.find((s) => s.stage <= S.stage && S.arrivals[s.id] && !S.seen[s.id]);
  if (sp) {
    if (sp.stage !== view) setView(sp.stage);          // 1つ目の地図を見返している間に2つ目の名所へ着いたら、2つ目の地図に戻す
    openSpot(sp, true);
    return;
  }
  // 1つ目の最後の名所を見終えているのに、まだ2つ目に進んでいないとき(途中でアプリを閉じた場合など)
  if (S.stage < STAGES.length - 1 && S.seen[STAGES[S.stage].last.id]) openStageClear();
}

function openSpot(sp, firstTime) {
  current = sp;
  const st = STAGES[sp.stage], w = WORD[st.id];
  const goal = sp === st.last;

  $("mArea").textContent = sp.area;
  $("mName").textContent = sp.name;
  $("mTag").textContent = sp.tag;
  $("mFact").textContent = sp.fact;
  $("mVisit").textContent = st.title + " " + (st.spots.indexOf(sp) + 1) + " / " + st.spots.length + " ・ 訪れた日: " + sp.days.join("、");
  $("modal").hidden = false;
  $("mClose").textContent = firstTime ? (goal ? (sp.stage < STAGES.length - 1 ? SEASON[st.id] + "の旅を終える" : "旅を終える") : "つぎへ") : "とじる";

  const box = $("mPhotos");
  box.replaceChildren();
  for (const ph of sp.photos) {
    const fig = document.createElement("figure");
    fig.className = "photo";
    const img = document.createElement("img");
    img.src = "photos/" + ph.f; img.alt = ph.place + "の" + w;
    const cap = document.createElement("figcaption");
    cap.textContent = ph.date + " 撮影 / " + ph.place;
    fig.append(img, cap);
    box.append(fig);
  }
  $("mNoPhoto").hidden = sp.photos.length > 0;
  $("mNoPhoto").textContent = "この名所の写真はまだありません。";
  const what = sp.name.includes("イチョウ") ? "黄葉" : w;
  $("mSay").textContent = firstTime ? "「" + sp.name + "」に到着! 思い出の" + what + "だよ。" : "思い出の" + what + "だよ。";
  document.querySelector("#modal .sheet").scrollTop = 0;
}

function openStageClear() {
  const a = FIRST, b = SECOND;
  $("clearSub").textContent = a.title + " 完了!";
  $("clearTitle").textContent = "つぎは " + b.title;
  $("clearGo").textContent = S2 + "の旅へ出発";
  $("clearText").textContent = a.spots.length + "か所の" + WORD[a.id] + "の名所を歩き切りました。つぎは" + b.spots.length +
    "か所の" + WORD[b.id] + "の名所をめぐります。もう一度、秋田駅からスタートです。";
  $("stageClear").hidden = false;
}

function openFinale() {
  const a = STAGES[0].last, b = STAGES[STAGES.length - 1].last;
  if (a.photos[0]) $("finA").src = "photos/" + a.photos[0].f;
  if (b.photos[0]) $("finB").src = "photos/" + b.photos[0].f;
  $("finSub").textContent = S1 + "と" + S2 + "、両方の旅が完了!";
  $("finText").textContent = STAGES.map((st) => WORD[st.id] + " " + st.spots.length + "か所").join("、") + "。合計 " +
    fmt(TOTAL_STEPS) + "歩の旅でした。おつかれさま!";
  $("finale").hidden = false;
}

$("mClose").addEventListener("click", () => {
  const sp = current;
  const first = sp && !S.seen[sp.id];
  if (sp) S.seen[sp.id] = true;
  save();
  $("modal").hidden = true;
  current = null;
  render();
  const lastOfStage = sp && sp === STAGES[sp.stage].last;
  if (first && lastOfStage && sp.stage < STAGES.length - 1) openStageClear();
  else if (first && lastOfStage) openFinale();
  else showNextArrival();
});

$("clearGo").addEventListener("click", () => {
  $("stageClear").hidden = true;
  if (S.stage < STAGES.length - 1) S.stage += 1;
  save();
  setView(S.stage);
  registerArrivals();          // 1つ目の分を超えて歩いていた歩数で、2つ目の名所に着いていれば続けて表示
  render();
  window.scrollTo(0, 0);
});
$("pick").addEventListener("click", (e) => {
  const b = e.target.closest ? e.target.closest("[data-main]") : null;
  if (!b) return;
  S.main = b.dataset.main;
  save();
  shareSync();
  applyChara();
  $("pick").hidden = true;
  render();
  registerArrivals();
});
$("fClose").addEventListener("click", () => { $("finale").hidden = true; render(); });
$("goalOpen").addEventListener("click", openFinale);
$("stages").addEventListener("click", (e) => {
  const b = e.target.closest(".stage-tab");
  if (b && !b.disabled && Number(b.dataset.stage) !== view) setView(Number(b.dataset.stage));
});

// ---------- テスト用ボタン ----------
// ブラウザでは常に出す。アプリではテスト版(devtest ビルド。debug.js で DEBUG_BUTTONS = true)だけに出す。
const DEBUG = window.DEBUG_BUTTONS === true;
if ((!NATIVE && (!WEB || location.search.includes("dev"))) || DEBUG) {
  $("dev").hidden = false;
  let resetArmed = false;
  $("dev").addEventListener("click", (e) => {
    const add = e.target.dataset.add;
    if (add) {
      if (NATIVE || WEB) {
        // アプリでは歩数センサーの値はそのままにして、旅の歩数だけ足す(Web版はセンサーが無いので同じく直接足す)
        S.total += Number(add);
        S.history.push([Date.now(), S.total]);
        save(); registerArrivals(); render();
      } else {
        S.mockCounter = (S.mockCounter || 0) + Number(add);
        if (S.lastCounter === null) S.lastCounter = 0;
        sync();
      }
    } else if (e.target.hasAttribute("data-reset")) {
      if (!resetArmed) {                     // 押しまちがい防止: 2回押すとリセット
        resetArmed = true; e.target.textContent = "もう一度押すとリセット";
        setTimeout(() => { resetArmed = false; e.target.textContent = "リセット"; }, 4000);
        return;
      }
      resetArmed = false; e.target.textContent = "リセット";
      const keepCounter = NATIVE ? S.lastCounter : 0;
      S = freshState(); S.lastCounter = keepCounter; save();
      ["modal", "stageClear", "finale"].forEach((id) => { $(id).hidden = true; });
      current = null;
      applyChara();
      setView(0);
      openPick();                            // リセットしたら主人公も選び直す
    }
  });
}

// ---------- Web版: 歩数の手入力 ----------
// 日付ごとの歩数を S.days に持ち、入れ直した分(差分)だけ旅が進む。
const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

function setDaySteps(date, value) {
  S.days = S.days || {};
  const old = S.days[date] || 0;
  S.days[date] = value;
  S.total = Math.max(0, S.total + (value - old));
  S.history.push([Date.now(), S.total]);
  save();
  registerArrivals();
  render();
  renderDays();
}

function renderDays() {
  const days = Object.entries(S.days || {}).sort().reverse().slice(0, 7);
  $("mDays").textContent = days.length ? "記録: " + days.map(([d, v]) => d.slice(5).replace("-", "/") + " " + fmt(v) + "歩").join(" ・ ") : "";
}

if (WEB) {
  $("manual").hidden = false;
  $("mDate").value = ymd(new Date());
  $("mSave").addEventListener("click", () => {
    const v = Math.round(Number($("mSteps").value));
    if (!$("mDate").value || !(v >= 0) || v > 200000) { $("mDays").textContent = "歩数は0〜200,000の数字で入れてください。"; return; }
    setDaySteps($("mDate").value, v);
    $("mSteps").value = "";
  });
  $("mDate").addEventListener("change", () => {
    const v = (S.days || {})[$("mDate").value];
    $("mSteps").value = v === undefined ? "" : v;
  });
  renderDays();
}

// ---------- 2人で旅する(なかまの位置) ----------
// 各端末が「名前・主人公・累計歩数・季節」を GitHub の非公開リポジトリ(players/<端末ID>.json)に書き、相手の分を読む。
// 鍵(fine-grained トークン。このリポジトリの Contents 読み書きだけ)は各端末で入力し、localStorage に置く(旅の記録とは別のキー)。
// 読むのは60秒ごと・画面を開いたとき。書くのは歩数が変わって5分たったとき・季節が変わったとき・画面を閉じるとき(コミットを増やしすぎない)。
const SYNC = { repo: "ayrton1224-dot/tohoku-season-sync", dir: "players", every: 60000, pushEvery: 300000, staleDays: 14, timeout: 15000 };
const SHARE_KEY = "tohoku-share-v1";
let SH = (() => { try { return JSON.parse(localStorage.getItem(SHARE_KEY)) || {}; } catch (e) { return {}; } })();
function saveShare() { try { localStorage.setItem(SHARE_KEY, JSON.stringify(SH)); } catch (e) { /* 保存できなくても動く */ } }
if (!SH.id) { SH.id = Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4); saveShare(); }
let mates = [];                                  // なかまの記録 [{ id, name, main, total, si(季節の番号), t }]
const mateCache = {};                            // ファイル名 → { sha, data }(変わっていなければ読み直さない)
let mySent = null, myStage = null, lastPush = 0, syncMsg = "";
let syncing = false, pending = false, pendingForce = false, shareGen = 0;   // shareGen: 「やめる」「保存」で増やし、古い同期の結果を捨てる

const b64 = (str) => btoa(unescape(encodeURIComponent(str)));
function gh(path, opt) {
  opt = opt || {};
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), SYNC.timeout) : null;     // 通信が止まっても同期が固まらないように
  return fetch("https://api.github.com/repos/" + SYNC.repo + "/contents/" + path, {
    method: opt.method || "GET", body: opt.body, cache: "no-store", signal: ac ? ac.signal : undefined,
    headers: { Authorization: "Bearer " + SH.token, Accept: opt.accept || "application/vnd.github+json" },
  }).finally(() => { if (timer) clearTimeout(timer); });
}
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "たった今" : m < 60 ? m + "分前" : m < 1440 ? Math.round(m / 60) + "時間前" : Math.round(m / 1440) + "日前";
}
// 自分の記録を書く。2台が同時に書いて sha がずれた(409/422)ときは、sha を取り直して1回だけやり直す
async function putMine(rec, sha) {
  const file = SYNC.dir + "/" + SH.id + ".json";
  const send = (s) => gh(file, { method: "PUT", body: JSON.stringify(Object.assign({ message: "update " + SH.id, content: b64(JSON.stringify(rec)) }, s ? { sha: s } : {})) });
  let w = await send(sha);
  if (w.status === 409 || w.status === 422) {
    const g = await gh(file);
    w = await send(g.ok ? (await g.json()).sha : null);
  }
  if (!w.ok) throw w.status;
}

async function shareSync(force) {
  if (!SH.token) return;
  if (syncing) { pending = true; pendingForce = pendingForce || force === true; return; }   // 同期中に呼ばれた分は、終わってからもう一度
  syncing = true;
  const gen = shareGen;
  try {
    const r = await gh(SYNC.dir);
    if (r.status !== 404 && !r.ok) throw r.status;
    const list = r.status === 404 ? [] : await r.json();
    if (gen !== shareGen) return;
    const files = (Array.isArray(list) ? list : []).filter((f) => f.name.endsWith(".json"));
    const mine = files.find((f) => f.name === SH.id + ".json");
    // 自分の記録
    const rec = { id: SH.id, name: SH.name || me().name, main: S.main || "yama", total: S.total, stage: S.stage, stageId: STAGES[S.stage].id, v: 2 };
    const key = JSON.stringify(rec);
    const due = force === true || Date.now() - lastPush >= SYNC.pushEvery || myStage !== S.stage;
    if (!mine || (key !== mySent && due)) {
      rec.t = Date.now();
      await putMine(rec, mine && mine.sha);
      mySent = key; myStage = S.stage; lastPush = Date.now();
    }
    // なかまの記録(sha が変わったものだけ読む)。古すぎる記録と、自分と同じ名前の記録(入れ直す前の自分)は出さない
    const out = [];
    for (const f of files) {
      if (f.name === SH.id + ".json") continue;
      let c = mateCache[f.name];
      if (!c || c.sha !== f.sha) {
        const g = await gh(f.path, { accept: "application/vnd.github.raw+json" });
        if (!g.ok) continue;
        try { c = mateCache[f.name] = { sha: f.sha, data: JSON.parse(await g.text()) }; } catch (e) { continue; }
      }
      const d = c.data;
      if (!d || !Number.isFinite(d.total) || !Number.isFinite(d.t)) continue;
      if (Date.now() - d.t > SYNC.staleDays * 86400000 || d.name === SH.name) continue;
      const si = d.stageId ? STAGES.findIndex((s) => s.id === d.stageId) : d.stage;   // 季節は id で合わせる(版で並びが違っても位置がずれない)
      if (!STAGES[si]) continue;
      out.push(Object.assign({}, d, { si }));
    }
    if (gen !== shareGen) return;
    mates = out.sort((a, b) => b.t - a.t).slice(0, 3);
    const n = new Date();
    syncMsg = "同期 " + n.getHours() + ":" + String(n.getMinutes()).padStart(2, "0");
  } catch (e) {
    if (gen === shareGen) {
      syncMsg = (e === 401 || e === 403 || e === 404) ? "鍵が使えません(入力ミス・期限切れ・権限を確認してください)"
        : "同期できませんでした(" + (typeof e === "number" ? e : "通信エラー") + ")。あとで自動でやり直します";
    }
  } finally {
    syncing = false;
    if (gen === shareGen) { renderShare(); render(); }
    if (pending) { const f = pendingForce; pending = pendingForce = false; setTimeout(() => shareSync(f), 0); }
  }
}

function renderShare() {
  const box = $("shareList");
  box.replaceChildren();
  const note = (t) => { const p = document.createElement("p"); p.className = "note"; p.textContent = t; box.append(p); };
  if (!SH.token) note("なかまと位置を見せ合うには、下の「設定」で名前と鍵を入れてください。");
  else if (!mates.length) note(syncMsg ? "なかまの記録はまだありません。なかまの端末でも設定すると表示されます。" : "同期しています…");
  for (const m of mates) {
    const st = STAGES[m.si], c = CHARA[m.main] || CHARA.yama;
    const nx = st.spots.find((s) => m.total < s.gcum);
    const diff = m.total - S.total;
    const div = document.createElement("div"); div.className = "share-who";
    const img = document.createElement("img"); img.src = "chara/" + c.walk + ".svg"; img.alt = c.name;
    const txt = document.createElement("div");
    const b = document.createElement("b"); b.textContent = m.name + "(" + c.name + ")";
    txt.append(b, document.createElement("br"),
      document.createTextNode(st.title + " ・ " + fmt(m.total) + "歩(" +
        (diff === 0 ? "あなたと同じ" : "あなたより" + fmt(Math.abs(diff)) + "歩" + (diff > 0 ? "先" : "うしろ")) + ")"),
      document.createElement("br"),
      document.createTextNode((nx ? "つぎは" + nx.preArea + "の" + WORD[st.id] + "の名所まで あと" + fmt(nx.gcum - m.total) + "歩"
        : st.title + "を歩き切った") + " ・ " + ago(m.t)));
    div.append(img, txt);
    box.append(div);
  }
  $("shareStatus").textContent = SH.token ? (SH.name ? "あなたの名前: " + SH.name + " ・ " : "") + syncMsg : "";
  $("shareName").value = SH.name || "";
  $("shareToken").placeholder = SH.token ? "鍵は保存済み(入れ直すときだけ入力)" : "鍵(github_pat_…)";
  if (!SH.token) $("shareSet").open = true;
}

$("shareSave").addEventListener("click", () => {
  const name = $("shareName").value.trim(), tok = $("shareToken").value.trim();
  if (!name) { $("shareStatus").textContent = "名前を入れてください。"; return; }
  if (!tok && !SH.token) { $("shareStatus").textContent = "鍵を入れてください。"; return; }
  SH.name = name;
  if (tok) SH.token = tok;
  saveShare();
  $("shareToken").value = "";
  $("shareSet").open = false;
  shareGen++; syncMsg = ""; mySent = null; mates = [];
  renderShare();
  shareSync(true);
});
$("shareOff").addEventListener("click", () => {
  shareGen++; SH.token = null; mates = []; syncMsg = ""; mySent = null;
  saveShare(); renderShare(); render();
});

// ---------- 起動 ----------
if (S.stage > STAGES.length - 1) S.stage = STAGES.length - 1;
view = S.stage;
MapView.init({ root: $("map"), route: STAGES[view].route, spots: STAGES[view].spots, onTap: (id) => {
  const sp = ALL_SPOTS.find((s) => s.id === id);
  if (sp && S.arrivals[id]) openSpot(sp, false);
} });
Profile.init({ route: STAGES[view].route, spots: STAGES[view].spots, svg: $("profile") });
$("ver").textContent = "v0.8.1 ・ " + STAGES.map((st) => SEASON[st.id] + st.spots.length + "か所").join(" → ") + " ・ 2026/11/25";
document.addEventListener("visibilitychange", () => { sync(); shareSync(document.hidden); });   // 閉じるときは最新の歩数を取り込んで自分の記録を送り、開いたときは読み直す
setInterval(shareSync, SYNC.every);
renderShare();
setInterval(sync, 3000);
applyChara();
if (!CHARA[S.main]) openPick();      // 最初の起動: 主人公を選ぶ(選ぶまで到着画面は出さない)
render();
if (WEB) registerArrivals(); else sync();
shareSync();
