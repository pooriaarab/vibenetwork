/**
 * The local web app, as a single self-contained HTML string.
 *
 * Local-first: profile, feed, follow graph, presence roster, and DMs — all
 * served from this machine by `src/server.ts`. Peer text is always rendered
 * via textContent (input-safety). No external deps; inline CSS + JS only.
 *
 * Served as-is by the local HTTP server; not exported for library consumers.
 */
export const webAppHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>vibenetwork — decentralized social for AI coders</title>
<style>
  :root{
    --bg: #0f1419;
    --bg-1: #151c24;
    --bg-card: #1a2330;
    --bg-card-2: #1f2938;
    --fg: #e8eef6;
    --muted: #9aadc2;
    --muted-2: #6f8499;
    --border: rgba(232,238,246,0.09);
    --border-2: rgba(232,238,246,0.15);
    --accent: #5ec8ff;
    --accent-dim: #3aa8df;
    --mint: #7fe3c0;
    --coral: #ff7a68;
    --amber: #ffb15e;
    --danger: #ff6b6f;
    --shadow-1: 0 1px 2px rgba(0,0,0,.35);
    --shadow-2: 0 18px 40px -20px rgba(0,0,0,.65);
    --radius: 16px;
    --ease-out: cubic-bezier(.16,1,.3,1);
    --dur-fast: .18s;
    --dur-med: .42s;
  }
  @media (prefers-reduced-motion: reduce){
    *, *::before, *::after{
      animation-duration: .001s !important;
      animation-iteration-count: 1 !important;
      transition-duration: .001s !important;
    }
  }
  *{ box-sizing: border-box; }
  html,body{ margin:0; padding:0; }
  body{
    background:
      radial-gradient(1000px 560px at 10% -8%, rgba(94,200,255,.12), transparent 55%),
      radial-gradient(800px 480px at 92% 0%, rgba(127,227,192,.08), transparent 50%),
      var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }
  ::selection{ background: rgba(94,200,255,.35); }
  .mono{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  a, button, input, textarea{ font: inherit; color: inherit; }
  button{ cursor:pointer; }
  :focus-visible{ outline: 2px solid var(--mint); outline-offset: 2px; border-radius: 6px; }

  header.topbar{
    position: sticky; top:0; z-index: 40;
    display:flex; align-items:center; justify-content:space-between; gap:16px;
    padding: 14px 22px;
    background: rgba(15,20,25,.82);
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
    border-bottom: 1px solid var(--border);
  }
  .wordmark{ display:flex; align-items:baseline; gap:10px; }
  .wordmark .name{ font-size: 1.2rem; font-weight: 800; letter-spacing: -0.02em; }
  .wordmark .name span{ color: var(--accent); }
  .wordmark .tag{ font-size: .8rem; color: var(--muted); font-weight: 500; }
  .local-badge{
    display:inline-flex; align-items:center; gap:8px;
    padding: 6px 12px 6px 10px; border-radius: 999px;
    background: rgba(127,227,192,.09);
    border: 1px solid rgba(127,227,192,.28);
    font-size: .76rem; font-weight: 600; color: #bff2df; white-space: nowrap;
  }
  .local-badge .dot{
    width:7px; height:7px; border-radius:50%;
    background: var(--mint);
    box-shadow: 0 0 0 3px rgba(127,227,192,.18);
    animation: pulse-dot 2.4s ease-in-out infinite; flex-shrink:0;
  }
  @keyframes pulse-dot{
    0%,100%{ transform: scale(1); opacity:1; }
    50%{ transform: scale(1.35); opacity:.65; }
  }

  .hero{ max-width: 1280px; margin: 0 auto; padding: 28px 22px 6px; }
  .hero h1{
    font-size: clamp(1.5rem, 3vw, 2.2rem);
    line-height: 1.12; letter-spacing: -0.03em; font-weight: 800;
    max-width: 24ch; margin: 0 0 8px;
  }
  .hero p{ color: var(--muted); font-size: .95rem; max-width: 60ch; margin:0; line-height: 1.5; }

  .stage{
    max-width: 1280px; margin: 0 auto; padding: 22px 22px 80px;
    display: grid;
    grid-template-columns: minmax(260px, 300px) minmax(340px, 1fr) minmax(260px, 300px);
    gap: 20px; align-items: start;
  }
  @media (max-width: 1020px){
    .stage{ grid-template-columns: 1fr; max-width: 640px; }
  }

  .panel{ opacity: 0; transform: translateY(12px); }
  .loaded .panel{ animation: rise .7s var(--ease-out) forwards; }
  .loaded .panel:nth-of-type(1){ animation-delay: .02s; }
  .loaded .panel:nth-of-type(2){ animation-delay: .1s; }
  .loaded .panel:nth-of-type(3){ animation-delay: .18s; }
  @keyframes rise{ to{ opacity:1; transform: translateY(0); } }

  h2.panel-title{
    font-size: .98rem; font-weight: 700; margin: 0 0 12px;
    display:flex; align-items:center; justify-content:space-between; gap:8px;
  }
  h2.panel-title .count{
    font-size: .72rem; font-weight: 600; color: var(--muted-2);
    background: rgba(0,0,0,.25); border: 1px solid var(--border);
    padding: 2px 8px; border-radius: 999px;
  }

  .card{
    background: linear-gradient(180deg, var(--bg-card), var(--bg-card-2));
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-2);
    padding: 18px;
  }
  .card + .card{ margin-top: 14px; }

  .btn{
    border:0; border-radius: 11px; padding: 10px 14px; font-weight: 700; font-size: .86rem;
    display:inline-flex; align-items:center; justify-content:center; gap:6px;
    transition: transform var(--dur-fast) var(--ease-out), filter var(--dur-fast) ease;
  }
  .btn:active{ transform: scale(.97); }
  .btn-primary{
    background: linear-gradient(180deg, var(--accent), var(--accent-dim));
    color: #071018;
    box-shadow: 0 10px 20px -12px rgba(94,200,255,.55);
  }
  .btn-primary:hover{ filter: brightness(1.07); }
  .btn-ghost{
    background: transparent; color: var(--muted); border: 1px solid var(--border-2);
  }
  .btn-ghost:hover{ color: var(--fg); border-color: var(--muted-2); }
  .btn-danger{
    background: transparent; color: var(--danger); border: 1px solid rgba(255,107,111,.35);
  }
  .btn:disabled{ opacity:.45; cursor: not-allowed; filter:none; box-shadow:none; }
  .btn-block{ width: 100%; }
  .btn-sm{ padding: 6px 10px; font-size: .76rem; border-radius: 8px; }

  .field{
    width: 100%; border: 1px solid var(--border-2); border-radius: 10px;
    background: rgba(0,0,0,.22); color: var(--fg);
    padding: 10px 12px; outline: none; resize: vertical; min-height: 0;
  }
  .field:focus{ border-color: var(--accent); }
  .field::placeholder{ color: var(--muted-2); }
  label.lbl{ display:block; font-size: .74rem; font-weight: 600; color: var(--muted-2); margin-bottom: 5px; }

  .muted{ color: var(--muted); }
  .muted-2{ color: var(--muted-2); }
  .small{ font-size: .8rem; line-height: 1.45; }
  .tiny{ font-size: .72rem; }

  .profile-head{ display:flex; gap:12px; align-items:flex-start; margin-bottom: 12px; }
  .avatar{
    width: 52px; height: 52px; border-radius: 50%; flex-shrink:0;
    background: linear-gradient(135deg, rgba(94,200,255,.35), rgba(127,227,192,.25));
    border: 1px solid var(--border-2);
    display:flex; align-items:center; justify-content:center;
    font-weight: 800; font-size: 1.1rem; color: var(--fg);
  }
  .profile-head .h{ font-weight: 700; font-size: .98rem; word-break: break-all; }
  .profile-head .s{ color: var(--muted); font-size: .8rem; margin-top: 2px; }
  .marks{ color: var(--mint); font-size: .78rem; margin-top: 3px; }
  .chip-row{ display:flex; flex-wrap:wrap; gap:6px; margin-top: 10px; }
  .chip{
    font-size: .72rem; font-weight: 600; padding: 4px 9px; border-radius: 999px;
    background: rgba(94,200,255,.1); border: 1px solid rgba(94,200,255,.25); color: var(--accent);
  }
  .chip.mint{ background: rgba(127,227,192,.1); border-color: rgba(127,227,192,.25); color: var(--mint); }
  .chip.warn{ background: rgba(255,177,94,.1); border-color: rgba(255,177,94,.25); color: var(--amber); }
  .empty{
    text-align:center; padding: 22px 12px; color: var(--muted-2); font-size: .84rem; line-height: 1.5;
  }
  .empty strong{ display:block; color: var(--muted); margin-bottom: 4px; }

  .compose{ display:flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
  .compose-actions{ display:flex; align-items:center; justify-content:space-between; gap: 10px; }
  .compose-actions .counter{ font-size: .72rem; color: var(--muted-2); }
  .compose-actions .counter.hot{ color: var(--coral); }

  .feed-list{ display:flex; flex-direction: column; gap: 10px; max-height: 620px; overflow-y: auto; }
  .post{
    border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px;
    background: rgba(0,0,0,.14);
  }
  .post-meta{ display:flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .post-author{ font-weight: 700; font-size: .86rem; word-break: break-all; }
  .post-author .me{ color: var(--accent); font-size: .7rem; font-weight: 600; margin-left: 6px; }
  .post-ago{ font-size: .72rem; color: var(--muted-2); white-space: nowrap; }
  .post-text{ font-size: .88rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }

  .row-list{ display:flex; flex-direction: column; gap: 0; max-height: 280px; overflow-y: auto; }
  .row{
    display:flex; align-items:center; justify-content:space-between; gap:10px;
    padding: 9px 2px; border-bottom: 1px solid var(--border);
  }
  .row:last-child{ border-bottom: 0; }
  .row .who .h{ font-size: .86rem; font-weight: 600; word-break: break-all; }
  .row .who .s{ font-size: .7rem; color: var(--muted-2); margin-top: 2px; }
  .row-actions{ display:flex; gap: 6px; flex-shrink: 0; }

  .tabs{ display:flex; gap: 4px; padding: 3px; border-radius: 10px; background: rgba(0,0,0,.22); border: 1px solid var(--border); margin-bottom: 12px; }
  .tabs button{
    flex:1; border:0; background: transparent; color: var(--muted);
    padding: 7px 8px; border-radius: 8px; font-size: .78rem; font-weight: 600;
  }
  .tabs button.is-active{ background: var(--bg-card); color: var(--fg); box-shadow: var(--shadow-1); }

  .follow-form{ display:flex; gap: 8px; margin-bottom: 12px; }
  .follow-form .field{ flex: 1; min-width: 0; }
  .status{ font-size: .76rem; color: var(--muted-2); min-height: 1.2em; margin-top: 6px; }
  .status.ok{ color: var(--mint); }
  .status.err{ color: var(--coral); }

  /* DM panel */
  .dm-panel{
    display:flex; flex-direction: column;
    min-height: 280px; max-height: 420px;
  }
  .dm-head{
    display:flex; align-items:center; justify-content:space-between; gap:8px;
    padding-bottom: 10px; border-bottom: 1px solid var(--border); margin-bottom: 10px;
  }
  .dm-head .t{ font-weight: 700; font-size: .88rem; word-break: break-all; }
  .dm-msgs{
    flex:1; overflow-y: auto; display:flex; flex-direction: column; gap: 7px;
    padding: 4px 0 10px; min-height: 120px;
  }
  .dm-msg{
    max-width: 88%; padding: 7px 11px; border-radius: 12px;
    font-size: .82rem; line-height: 1.4; word-break: break-word; white-space: pre-wrap;
  }
  .dm-msg.them{ align-self: flex-start; background: rgba(232,238,246,.07); border: 1px solid var(--border); }
  .dm-msg.you{ align-self: flex-end; background: rgba(94,200,255,.14); border: 1px solid rgba(94,200,255,.3); }
  .dm-msg.sys{ align-self: center; background: transparent; border:0; color: var(--muted-2); font-size: .72rem; padding: 2px 6px; }
  .dm-inputrow{ display:flex; gap: 8px; border-top: 1px solid var(--border); padding-top: 10px; }
  .dm-inputrow .field{ flex: 1; min-width: 0; }
  .has-unread{ color: var(--coral) !important; border-color: var(--coral) !important; }

  footer.foot{
    max-width:1280px; margin: 0 auto; padding: 0 22px 40px;
    color: var(--muted-2); font-size:.74rem; line-height: 1.5;
  }

  @media (max-width: 480px){
    .hero{ padding: 22px 16px 4px; }
    .stage{ padding: 16px 16px 60px; }
    header.topbar{ padding: 12px 14px; flex-wrap: wrap; }
  }
</style>
</head>
<body>

<header class="topbar">
  <div class="wordmark">
    <span class="name">vibe<span>network</span></span>
    <span class="tag">decentralized social for AI coders</span>
  </div>
  <div class="local-badge"><span class="dot" aria-hidden="true"></span> local-first · signed posts · e2e DMs</div>
</header>

<div class="hero">
  <h1>Your graph. Your keys. One global topic.</h1>
  <p>Handle + league + verified flag on the wire — never raw usage. Posts are ed25519-signed; follows filter what you see, not who you meet.</p>
</div>

<main class="stage" id="stage">

  <!-- LEFT: profile + follow -->
  <div class="col">
    <section class="panel" aria-label="Your profile">
      <h2 class="panel-title">Profile</h2>
      <div class="card" id="profileCard">
        <div class="empty" id="profileEmpty">
          <strong>Not connected yet.</strong>
          Run <span class="mono">vibenetwork connect</span> in a terminal, then reload.
        </div>
        <div id="profileBody" hidden>
          <div class="profile-head">
            <div class="avatar" id="profileAvatar">@</div>
            <div>
              <div class="h" id="profileHandle">@you</div>
              <div class="s" id="profileLeague">—</div>
              <div class="marks" id="profileMarks"></div>
            </div>
          </div>
          <p class="small muted" id="profileBio" style="margin:0 0 8px;"></p>
          <div class="chip-row" id="profileChips"></div>
          <p class="tiny muted-2 mono" id="profilePubkey" style="margin:12px 0 0; word-break:break-all;"></p>
        </div>
      </div>
    </section>

    <section class="panel" aria-label="Following" style="margin-top:18px;">
      <h2 class="panel-title">Following <span class="count" id="followCount">0</span></h2>
      <div class="card">
        <form class="follow-form" id="followForm">
          <input class="field" id="followInput" type="text" placeholder="@handle or pubkey" maxlength="80" autocomplete="off">
          <button class="btn btn-primary btn-sm" type="submit">Follow</button>
        </form>
        <div class="row-list" id="followList"></div>
        <div class="status" id="followStatus" role="status"></div>
      </div>
    </section>
  </div>

  <!-- CENTER: feed -->
  <div class="col">
    <section class="panel" aria-label="Feed">
      <h2 class="panel-title">
        Feed
        <span class="count" id="feedCount">0</span>
      </h2>
      <div class="card">
        <div class="tabs" role="tablist" aria-label="Feed filter">
          <button type="button" class="is-active" data-feed="following" id="tabFollowing">Following</button>
          <button type="button" data-feed="all" id="tabAll">Firehose</button>
        </div>

        <div class="compose" id="composeBox">
          <label class="lbl" for="composeText">New post</label>
          <textarea class="field" id="composeText" rows="3" maxlength="500" placeholder="What's shipping? (1–500 chars, signed with your key)"></textarea>
          <div class="compose-actions">
            <span class="counter mono" id="composeCounter">0 / 500</span>
            <button class="btn btn-primary btn-sm" id="composeBtn" type="button">Post</button>
          </div>
          <div class="status" id="composeStatus" role="status"></div>
        </div>

        <div class="feed-list" id="feedList">
          <div class="empty"><strong>Loading feed…</strong></div>
        </div>
      </div>
    </section>
  </div>

  <!-- RIGHT: who's online + DMs -->
  <div class="col">
    <section class="panel" aria-label="Who is online">
      <h2 class="panel-title">Who's online <span class="count" id="whoCount">0</span></h2>
      <div class="card">
        <p class="tiny muted-2" style="margin:0 0 10px;">Live peers on <span class="mono">vibenet:all</span>. Marks: ✓ usage · 🔑 identity.</p>
        <div class="row-list" id="whoList">
          <div class="empty"><strong>No peers yet.</strong>Presence fills in when the CLI joins the swarm.</div>
        </div>
      </div>
    </section>

    <section class="panel" aria-label="Direct messages" style="margin-top:18px;">
      <h2 class="panel-title">DMs</h2>
      <div class="card dm-panel">
        <div class="dm-head">
          <div>
            <div class="t" id="dmTitle">No conversation</div>
            <div class="tiny muted-2" id="dmSub">Pick a peer from Who's online</div>
          </div>
        </div>
        <div class="dm-msgs" id="dmMsgs">
          <div class="empty">Open a chat to start messaging over the P2P link.</div>
        </div>
        <div class="dm-inputrow">
          <input class="field" id="dmInput" type="text" maxlength="4000" placeholder="message…" autocomplete="off" disabled>
          <button class="btn btn-primary btn-sm" id="dmSend" type="button" disabled>Send</button>
        </div>
      </div>
    </section>
  </div>

</main>

<footer class="foot">
  Local-first. Raw token usage never leaves this device — only your league + verified flag ride the signed hello.
  Peer text is untrusted display data. Identity = persistent ed25519 key in <span class="mono">~/.vibenetwork</span>.
</footer>

<script>
(function(){
  "use strict";

  var POST_MAX = 500;
  var MAX_CHAT_KEPT = 200;
  var feedMode = "following"; // "following" | "all"
  var profile = { connected: false };
  var peers = [];
  var chatWith = null;
  var conversations = {}; // handle -> [{from, text}]
  var unread = {};
  var chatLoops = {};

  function $(id){ return document.getElementById(id); }
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  function fmtAgo(at){
    var t = typeof at === "number" ? at : Date.parse(at);
    if (!isFinite(t)) return "";
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }
  function initial(handle){
    var body = (handle || "?").replace(/^@+/, "");
    return (body.charAt(0) || "?").toUpperCase();
  }
  function setStatus(el, text, kind){
    el.textContent = text || "";
    el.className = "status" + (kind ? " " + kind : "");
  }
  function peerKnown(handle){
    for (var i = 0; i < peers.length; i++) if (peers[i].handle === handle) return true;
    return false;
  }

  /* ---- profile ---- */
  function renderProfile(p){
    profile = p || { connected: false };
    if (!profile.connected){
      $("profileEmpty").hidden = false;
      $("profileBody").hidden = true;
      $("composeBtn").disabled = true;
      $("composeText").disabled = true;
      return;
    }
    $("profileEmpty").hidden = true;
    $("profileBody").hidden = false;
    $("composeBtn").disabled = false;
    $("composeText").disabled = false;
    $("profileAvatar").textContent = initial(profile.handle);
    $("profileHandle").textContent = profile.handle || "@you";
    $("profileLeague").textContent = (profile.league || "—") + " League";
    $("profileMarks").textContent = profile.verified ? "✓ usage verified (real local logs)" : "~ self-reported / demo";
    $("profileBio").textContent = profile.bio || "No bio yet — set one with: vibenetwork profile --bio \\"...\\"";
    $("profilePubkey").textContent = "pubkey " + (profile.pubkey || "");
    var chips = $("profileChips");
    chips.innerHTML = "";
    var c1 = document.createElement("span");
    c1.className = "chip";
    c1.textContent = profile.league || "below-1M";
    chips.appendChild(c1);
    var c2 = document.createElement("span");
    c2.className = "chip " + (profile.verified ? "mint" : "warn");
    c2.textContent = profile.verified ? "verified" : "unverified";
    chips.appendChild(c2);
  }

  /* ---- feed ---- */
  function renderFeed(data){
    var list = $("feedList");
    list.innerHTML = "";
    var posts = (data && data.posts) || [];
    $("feedCount").textContent = String(posts.length);
    if (posts.length === 0){
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.innerHTML = feedMode === "all"
        ? "<strong>Firehose is empty.</strong>Post something, or wait for peers to sync."
        : "<strong>Nothing from people you follow.</strong>Follow coders from Who's online, or switch to Firehose.";
      list.appendChild(empty);
      return;
    }
    posts.forEach(function(p){
      var el = document.createElement("article");
      el.className = "post";
      var meta = document.createElement("div");
      meta.className = "post-meta";
      var author = document.createElement("div");
      author.className = "post-author";
      author.textContent = p.author || ("@" + (p.authorPubkey || "").slice(0, 8));
      if (p.mine){
        var me = document.createElement("span");
        me.className = "me";
        me.textContent = "you";
        author.appendChild(me);
      }
      var ago = document.createElement("div");
      ago.className = "post-ago mono";
      ago.textContent = fmtAgo(p.at);
      meta.appendChild(author);
      meta.appendChild(ago);
      var text = document.createElement("div");
      text.className = "post-text";
      // textContent only — peer post bodies are untrusted.
      text.textContent = p.text || "";
      el.appendChild(meta);
      el.appendChild(text);
      list.appendChild(el);
    });
  }

  function loadFeed(){
    var q = feedMode === "all" ? "?all=1" : "";
    return fetch("/api/feed" + q)
      .then(function(r){ return r.json(); })
      .then(renderFeed)
      .catch(function(){ /* keep previous */ });
  }

  $("tabFollowing").addEventListener("click", function(){
    feedMode = "following";
    $("tabFollowing").classList.add("is-active");
    $("tabAll").classList.remove("is-active");
    loadFeed();
  });
  $("tabAll").addEventListener("click", function(){
    feedMode = "all";
    $("tabAll").classList.add("is-active");
    $("tabFollowing").classList.remove("is-active");
    loadFeed();
  });

  var composeText = $("composeText");
  var composeCounter = $("composeCounter");
  function refreshCounter(){
    var n = composeText.value.length;
    composeCounter.textContent = n + " / " + POST_MAX;
    composeCounter.classList.toggle("hot", n > POST_MAX - 40);
  }
  composeText.addEventListener("input", refreshCounter);
  refreshCounter();

  $("composeBtn").addEventListener("click", function(){
    var text = composeText.value;
    if (!text || !text.trim()) {
      setStatus($("composeStatus"), "Write something first.", "err");
      return;
    }
    $("composeBtn").disabled = true;
    fetch("/api/post", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: text })
    }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, status: r.status, j: j }; }); })
      .then(function(res){
        $("composeBtn").disabled = !profile.connected;
        if (!res.ok) {
          setStatus($("composeStatus"), (res.j && res.j.error) || "post failed", "err");
          return;
        }
        composeText.value = "";
        refreshCounter();
        var delivered = res.j && res.j.delivered || 0;
        setStatus($("composeStatus"),
          delivered > 0 ? "Posted · delivered to " + delivered + " peer(s)" : "Posted · stored locally",
          "ok");
        loadFeed();
      }).catch(function(){
        $("composeBtn").disabled = !profile.connected;
        setStatus($("composeStatus"), "server unreachable", "err");
      });
  });

  /* ---- follow ---- */
  function renderFollows(data){
    var list = $("followList");
    list.innerHTML = "";
    var follows = (data && data.follows) || [];
    $("followCount").textContent = String(follows.length);
    if (follows.length === 0){
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.innerHTML = "<strong>Not following anyone.</strong>Add a @handle or pubkey above.";
      list.appendChild(empty);
      return;
    }
    follows.forEach(function(f){
      var row = document.createElement("div");
      row.className = "row";
      var who = document.createElement("div");
      who.className = "who";
      var h = document.createElement("div");
      h.className = "h";
      h.textContent = f.handle || (f.pubkey ? f.pubkey.slice(0, 12) + "…" : "?");
      var s = document.createElement("div");
      s.className = "s mono";
      s.textContent = f.pubkey ? f.pubkey.slice(0, 16) + "…" : "handle edge";
      who.appendChild(h); who.appendChild(s);
      var actions = document.createElement("div");
      actions.className = "row-actions";
      var btn = document.createElement("button");
      btn.className = "btn btn-danger btn-sm";
      btn.type = "button";
      btn.textContent = "Unfollow";
      var target = f.handle || f.pubkey;
      btn.addEventListener("click", function(){ doFollow(target, true); });
      actions.appendChild(btn);
      row.appendChild(who);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  function loadFollows(){
    return fetch("/api/follow")
      .then(function(r){ return r.json(); })
      .then(renderFollows)
      .catch(function(){});
  }

  function doFollow(target, unfollow){
    return fetch("/api/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: target, unfollow: !!unfollow })
    }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        if (!res.ok) {
          setStatus($("followStatus"), (res.j && res.j.error) || "failed", "err");
          return;
        }
        setStatus($("followStatus"),
          unfollow ? "Unfollowed " + target : "Following " + target,
          "ok");
        renderFollows(res.j);
        loadFeed();
        renderWho(peers);
      }).catch(function(){
        setStatus($("followStatus"), "server unreachable", "err");
      });
  }

  $("followForm").addEventListener("submit", function(e){
    e.preventDefault();
    var t = $("followInput").value.trim();
    if (!t) return;
    doFollow(t, false).then(function(){ $("followInput").value = ""; });
  });

  /* ---- who + DMs ---- */
  function renderWho(list){
    peers = list || [];
    $("whoCount").textContent = String(peers.length);
    var el = $("whoList");
    el.innerHTML = "";
    if (peers.length === 0){
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.innerHTML = "<strong>No peers online.</strong>The roster fills when presence joins the swarm.";
      el.appendChild(empty);
      return;
    }
    peers.forEach(function(p){
      ensureChatLoop(p.handle);
      var row = document.createElement("div");
      row.className = "row";
      var who = document.createElement("div");
      who.className = "who";
      var marks = (p.verified === true ? " ✓" : " ~") + (p.identityVerified === true ? " 🔑" : "");
      var h = document.createElement("div");
      h.className = "h";
      // textContent — handles are untrusted wire data.
      h.textContent = (p.handle || "?") + marks;
      var s = document.createElement("div");
      s.className = "s";
      s.textContent = (p.league || "?") + " · " + (p.harness || "?") + (p.followed ? " · following" : "");
      who.appendChild(h); who.appendChild(s);
      var actions = document.createElement("div");
      actions.className = "row-actions";
      if (!p.followed){
        var fbtn = document.createElement("button");
        fbtn.className = "btn btn-ghost btn-sm";
        fbtn.type = "button";
        fbtn.textContent = "Follow";
        fbtn.addEventListener("click", function(){ doFollow(p.handle, false); });
        actions.appendChild(fbtn);
      }
      var cbtn = document.createElement("button");
      cbtn.className = "btn btn-primary btn-sm" + (unread[p.handle] ? " has-unread" : "");
      cbtn.type = "button";
      cbtn.textContent = "DM" + (unread[p.handle] ? " (" + unread[p.handle] + ")" : "");
      cbtn.addEventListener("click", function(){ openChat(p.handle); });
      actions.appendChild(cbtn);
      row.appendChild(who);
      row.appendChild(actions);
      el.appendChild(row);
    });
    if (chatWith) {
      $("dmSub").textContent = peerKnown(chatWith)
        ? "live over the P2P link · e2e"
        : "peer offline · messages will not deliver";
    }
  }

  function loadWho(){
    return fetch("/api/who")
      .then(function(r){ return r.json(); })
      .then(function(j){ renderWho((j && j.peers) || []); })
      .catch(function(){});
  }

  function fetchDm(handle, timeoutMs){
    var ctrl = new AbortController();
    var t = setTimeout(function(){ ctrl.abort(); }, timeoutMs);
    // wait=1 selects the long-poll path (mirrors vibedating /live/message).
    return fetch("/api/dm?wait=1&handle=" + encodeURIComponent(handle), { signal: ctrl.signal })
      .then(function(r){ clearTimeout(t); return r; })
      .catch(function(e){ clearTimeout(t); throw e; });
  }

  function pushChat(handle, entry){
    var conv = conversations[handle] || (conversations[handle] = []);
    conv.push(entry);
    if (conv.length > MAX_CHAT_KEPT) conv.splice(0, conv.length - MAX_CHAT_KEPT);
  }

  function ensureChatLoop(handle){
    if (chatLoops[handle]) return;
    chatLoops[handle] = true;
    (async function(){
      while (peerKnown(handle)) {
        var res;
        try { res = await fetchDm(handle, 30000); }
        catch(e){ await sleep(1000); continue; }
        if (!res || res.status !== 200) { await sleep(1000); continue; }
        var data = await res.json();
        var m = data && data.message;
        if (!m) continue;
        pushChat(handle, { from: "them", text: m.text });
        if (chatWith === handle) renderChat();
        else {
          unread[handle] = (unread[handle] || 0) + 1;
          renderWho(peers);
        }
      }
      delete chatLoops[handle];
    })();
  }

  function renderChat(){
    var box = $("dmMsgs");
    box.innerHTML = "";
    var conv = (chatWith && conversations[chatWith]) || [];
    if (!chatWith){
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Open a chat to start messaging over the P2P link.";
      box.appendChild(empty);
      return;
    }
    if (conv.length === 0){
      var hi = document.createElement("div");
      hi.className = "empty";
      hi.textContent = "No messages yet — say hi.";
      box.appendChild(hi);
      return;
    }
    conv.forEach(function(m){
      var el = document.createElement("div");
      el.className = "dm-msg " + (m.from === "you" ? "you" : m.from === "sys" ? "sys" : "them");
      el.textContent = m.text;
      box.appendChild(el);
    });
    box.scrollTop = box.scrollHeight;
  }

  function openChat(handle){
    chatWith = handle;
    delete unread[handle];
    $("dmTitle").textContent = handle;
    $("dmSub").textContent = peerKnown(handle)
      ? "live over the P2P link · e2e"
      : "peer offline · messages will not deliver";
    $("dmInput").disabled = false;
    $("dmSend").disabled = false;
    renderChat();
    renderWho(peers);
    $("dmInput").focus();
  }

  function sendDm(){
    var target = chatWith;
    var text = $("dmInput").value.trim();
    if (!target || text === "") return;
    $("dmInput").value = "";
    fetch("/api/dm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: target, text: text })
    }).then(function(res){
      pushChat(target, res && res.status === 200
        ? { from: "you", text: text }
        : { from: "sys", text: "(not delivered — peer offline?)" });
      if (chatWith === target) renderChat();
    }).catch(function(){
      pushChat(target, { from: "sys", text: "(not delivered — server unreachable)" });
      if (chatWith === target) renderChat();
    });
  }
  $("dmSend").addEventListener("click", sendDm);
  $("dmInput").addEventListener("keydown", function(e){ if (e.key === "Enter") sendDm(); });

  /* ---- boot ---- */
  function boot(){
    fetch("/api/profile")
      .then(function(r){ return r.json(); })
      .then(renderProfile)
      .catch(function(){ renderProfile({ connected: false }); });
    loadFeed();
    loadFollows();
    loadWho();
    setInterval(loadWho, 4000);
    setInterval(loadFeed, 12000);
    requestAnimationFrame(function(){ document.body.classList.add("loaded"); });
  }
  boot();
})();
</script>
</body>
</html>`;
