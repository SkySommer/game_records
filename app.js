const STORAGE_KEY = "lol-solo-swiss-records";
const RECORDS_API = "/.netlify/functions/records";
const HISTORY_PAGE_SIZE = 10;
const DOUBLE_ELIMINATION_LOSSES = 2;
const DEFAULT_PLAYER_NAMES = [];
const LOCAL_ADMIN_USERNAME = "admin";
const LOCAL_ADMIN_PASSWORD = "admin123456";
const FORMAT_COPY = {
  "round-robin": ["传统循环赛", "4 人单循环，每人打 3 场；3 轮 6 场，按胜场排名。"],
  "single-elimination": ["四人单败淘汰赛", "半决赛与决赛共 2 轮 3 场；输半决赛即淘汰。"],
  "double-elimination": ["双败淘汰", "胜者组在上、败者组在下；输满 2 场淘汰，必要时启用重置赛。"],
  swiss: ["瑞士轮", "4 人按相近战绩配对，共 3 轮；按胜场排名。"],
};

const els = {
  form: document.querySelector("#settings-form"),
  tournamentName: document.querySelector("#tournament-name"),
  playerCount: document.querySelector("#player-count"),
  targetScore: document.querySelector("#target-score"),
  matchTargetScore: document.querySelector("#match-target-score"),
  formatSelect: document.querySelector("#format-select"),
  ruleNote: document.querySelector(".rule-note"),
  matchTargetField: document.querySelector(".match-target-field"),
  playerNameGrid: document.querySelector("#player-name-grid"),
  resetBtn: document.querySelector("#reset-btn"),
  nextRoundBtn: document.querySelector("#next-round-btn"),
  standings: document.querySelector("#standings"),
  matches: document.querySelector("#matches"),
  roundTitle: document.querySelector("#round-title"),
  roundNote: document.querySelector("#round-note"),
  roundMetric: document.querySelector("#round-metric"),
  activeMetric: document.querySelector("#active-metric"),
  advancedMetric: document.querySelector("#advanced-metric"),
  eliminatedMetric: document.querySelector("#eliminated-metric"),
  historySummary: document.querySelector("#history-filters"),
  historyList: document.querySelector("#history-list"),
  historyPagination: document.querySelector("#history-pagination"),
  historyDetail: document.querySelector("#history-detail"),
  historyNote: document.querySelector("#history-note"),
  historyViewTabs: document.querySelectorAll(".history-view-tab"),
  saveStatus: document.querySelector("#save-status"),
  matchTemplate: document.querySelector("#match-template"),
  navTabs: document.querySelectorAll(".nav-tab"),
  adminEntry: document.querySelector("#admin-entry"),
  createPage: document.querySelector("#create-page"),
  historyPage: document.querySelector("#history-page"),
  adminPage: document.querySelector("#admin-page"),
  adminLoginForm: document.querySelector("#admin-login-form"),
  adminUsername: document.querySelector("#admin-username"),
  adminPassword: document.querySelector("#admin-password"),
  adminLoginError: document.querySelector("#admin-login-error"),
  adminLogout: document.querySelector("#admin-logout"),
  adminTools: document.querySelector("#admin-tools"),
  adminPlayerList: document.querySelector("#admin-player-list"),
  savePlayerList: document.querySelector("#save-player-list"),
  adminHistoryList: document.querySelector("#admin-history-list"),
};

let appData = loadAppData();
let state = appData.current;
let currentPage = "create";
let historyView = "schedule";
let historyPageIndex = 1;
let selectedHistoryId = appData.history[0]?.id || null;
let selectedStatsPlayerName = null;
let adminSession = null;

function isLocalFrontend() {
  const host = window.location.hostname;
  return (
    ["localhost", "127.0.0.1", "::1", ""].includes(host) ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

function isLocalAdmin(credentials) {
  return credentials?.username === LOCAL_ADMIN_USERNAME && credentials?.password === LOCAL_ADMIN_PASSWORD;
}

async function createTournament(event) {
  event.preventDefault();
  const count = clampNumber(els.playerCount.value, 2, 32);
  const targetScore = clampNumber(els.targetScore.value, 1, 99);
  const matchTargetScore = clampNumber(els.matchTargetScore.value, 1, 99);
  const format = els.formatSelect.value;
  const suppliedNames = getPlayerNameInputs();
  const duplicateNames = suppliedNames.filter((name, index) => name && suppliedNames.indexOf(name) !== index);
  if (suppliedNames.length < count || suppliedNames.some((name) => !name)) {
    window.alert("请为每个席位选择预设选手。");
    return;
  }
  if (duplicateNames.length) {
    window.alert("同一场赛程中不能重复选择同一名选手。");
    return;
  }
  await archiveCurrentTournament();
  selectedHistoryId = appData.history[0]?.id || null;

  const players = Array.from({ length: count }, (_, index) => ({
    id: crypto.randomUUID(),
    name: suppliedNames[index],
    wins: 0,
    losses: 0,
    status: "active",
    previousOpponents: [],
    bye: false,
  }));

  state = {
    id: crypto.randomUUID(),
    name: normalizeTournamentName(els.tournamentName.value, format),
    createdAt: new Date().toISOString(),
    format,
    settings: { count, targetScore, matchTargetScore, eliminateLosses: DOUBLE_ELIMINATION_LOSSES },
    players,
    rounds: [],
    currentRound: 0,
  };

  appData.current = state;
  generateNextRound();
}

function generateNextRound() {
  if (!state) return;
  if (state.rounds.length && !isRoundComplete(currentRound())) return;
  updatePlayerStatuses();

  const nextRound = buildNextRound();
  if (!nextRound) {
    saveAndRender();
    return;
  }

  state.currentRound += 1;
  state.rounds.push(nextRound);
  saveAndRender();
}

function buildNextRound() {
  if (championId()) return null;
  return {
    "round-robin": buildNextRoundRobinRound,
    "single-elimination": buildNextSingleEliminationRound,
    "double-elimination": buildNextDoubleEliminationRound,
    swiss: buildNextSwissRound,
  }[state.format || "double-elimination"]();
}

function buildNextRoundRobinRound() {
  const players = state.players;
  const nextNumber = state.rounds.length + 1;
  const roundCount = players.length % 2 === 0 ? players.length - 1 : players.length;
  if (nextNumber > roundCount) return null;
  const pairs = roundRobinPairs(players, nextNumber);
  return makeRound(
    nextNumber,
    `循环赛第 ${nextNumber} 轮`,
    pairs.map((pair, index) => makeMatch(`R${nextNumber}-${index + 1}`, `循环赛第 ${nextNumber} 轮`, "循环赛", pair[0].id, pair[1].id))
  );
}

function buildNextSingleEliminationRound() {
  const nextNumber = state.rounds.length + 1;
  const participants = singleEliminationParticipants();
  if (participants.length <= 1) return null;
  const { pairs, byes } = pairSequentialIds(participants);
  const title = participants.length <= 2 ? "决赛" : participants.length <= 4 ? "半决赛" : `单败第 ${nextNumber} 轮`;
  return makeRound(
    nextNumber,
    title,
    pairs.map((pair, index) => makeMatch(`${participants.length <= 2 ? "F" : `SE${nextNumber}`}-${index + 1}`, title, "单败淘汰", pair[0], pair[1])),
    byes
  );
}

function buildNextDoubleEliminationRound() {
  if (state.players.length !== 4) return buildNextGenericDoubleEliminationRound();
  const nextNumber = state.rounds.length + 1;
  const players = state.players;
  if (nextNumber === 1) {
    return makeRound(1, "第一阶段", [
      makeMatch("W1", "胜者组首轮", "胜者组", players[0].id, players[1].id),
      makeMatch("W2", "胜者组首轮", "胜者组", players[2].id, players[3].id),
    ]);
  }

  const w1 = findMatchByCode("W1");
  const w2 = findMatchByCode("W2");
  if (nextNumber === 2 && w1?.winnerId && w2?.winnerId) {
    return makeRound(2, "第二阶段", [
      makeMatch("W3", "胜者组决赛", "胜者组", w1.winnerId, w2.winnerId),
      makeMatch("L1", "败者组首轮", "败者组", loserId(w1), loserId(w2)),
    ]);
  }

  const w3 = findMatchByCode("W3");
  const l1 = findMatchByCode("L1");
  if (nextNumber === 3 && w3?.winnerId && l1?.winnerId) {
    return makeRound(3, "第三阶段", [
      makeMatch("L2", "败者组决赛", "败者组", l1.winnerId, loserId(w3)),
    ]);
  }

  const l2 = findMatchByCode("L2");
  if (nextNumber === 4 && w3?.winnerId && l2?.winnerId) {
    return makeRound(4, "第四阶段", [
      makeMatch("GF1", "总决赛第一轮", "总决赛", w3.winnerId, l2.winnerId),
    ]);
  }

  const gf1 = findMatchByCode("GF1");
  if (nextNumber === 5 && gf1?.winnerId && gf1.winnerId === l2?.winnerId) {
    return makeRound(5, "重置赛", [
      makeMatch("RESET", "重置赛", "总决赛", gf1.playerAId, gf1.playerBId),
    ]);
  }

  return null;
}

function buildNextGenericDoubleEliminationRound() {
  const nextNumber = state.rounds.length + 1;
  const active = state.players.filter((player) => player.losses < DOUBLE_ELIMINATION_LOSSES).sort(sortByRecordThenName);
  if (active.length <= 1) return null;
  const lane = active.some((player) => player.losses === 1) ? "败者组" : "胜者组";
  const { pairs, byes } = pairSequentialIds(active.map((player) => player.id));
  return makeRound(
    nextNumber,
    `双败第 ${nextNumber} 轮`,
    pairs.map((pair, index) => makeMatch(`${lane === "胜者组" ? "W" : "L"}${nextNumber}-${index + 1}`, `${lane}第 ${nextNumber} 轮`, lane, pair[0], pair[1])),
    byes
  );
}

function buildNextSwissRound() {
  const nextNumber = state.rounds.length + 1;
  if (nextNumber > 3) return null;
  const players = [...state.players].sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.name.localeCompare(b.name, "zh-CN"));
  const pairs = [];
  const remaining = [...players];
  while (remaining.length) {
    const first = remaining.shift();
    if (!remaining.length) break;
    let opponentIndex = remaining.findIndex((candidate) => !first.previousOpponents.includes(candidate.id));
    if (opponentIndex === -1) opponentIndex = 0;
    const second = remaining.splice(opponentIndex, 1)[0];
    pairs.push([first, second]);
  }
  return makeRound(
    nextNumber,
    `瑞士轮第 ${nextNumber} 轮`,
    pairs.map((pair, index) => makeMatch(`S${nextNumber}-${index + 1}`, `瑞士轮第 ${nextNumber} 轮`, "瑞士轮", pair[0].id, pair[1].id))
  );
}

function makeRound(number, title, matches, byes = []) {
  return { number, title, byes, matches: matches.map((match, index) => ({ ...match, table: index + 1 })) };
}

function makeMatch(code, title, bracket, playerAId, playerBId) {
  return {
    id: crypto.randomUUID(),
    code,
    title,
    bracket,
    playerAId,
    playerBId,
    heroA: "",
    heroB: "",
    scoreA: 0,
    scoreB: 0,
    winnerId: null,
  };
}

function roundRobinPairs(players, roundNumber) {
  const slots = players.length % 2 === 0 ? [...players] : [...players, null];
  const fixed = slots[0];
  const rotating = slots.slice(1);
  for (let step = 1; step < roundNumber; step += 1) {
    rotating.unshift(rotating.pop());
  }
  const ordered = [fixed, ...rotating];
  const pairs = [];
  for (let index = 0; index < ordered.length / 2; index += 1) {
    const a = ordered[index];
    const b = ordered[ordered.length - 1 - index];
    if (a && b) pairs.push([a, b]);
  }
  return pairs;
}

function pairSequentialIds(ids) {
  const pairs = [];
  const byes = [];
  for (let index = 0; index < ids.length; index += 2) {
    if (ids[index + 1]) pairs.push([ids[index], ids[index + 1]]);
    else byes.push(ids[index]);
  }
  return { pairs, byes };
}

function singleEliminationParticipants() {
  if (!state.rounds.length) return state.players.map((player) => player.id);
  const previous = currentRound();
  return [
    ...previous.matches.filter((match) => match.winnerId).map((match) => match.winnerId),
    ...(previous.byes || []),
  ];
}

function render() {
  renderPlayerNameInputs();

  if (!state) {
    renderEmpty();
    renderHistory();
    return;
  }

  els.playerCount.value = state.settings.count;
  els.tournamentName.value = state.name || "";
  els.targetScore.value = state.settings.targetScore;
  els.matchTargetScore.value = state.settings.matchTargetScore;
  els.formatSelect.value = state.format || "double-elimination";
  updateRuleNote();
  renderPlayerNameInputs(state.players.map((player) => player.name));

  updatePlayerStatuses();
  renderMetrics();
  renderStandings();
  renderRound();
  renderHistory();
  els.saveStatus.textContent = "已自动保存";
}

function renderEmpty() {
  els.tournamentName.value = "";
  els.targetScore.value = 1;
  els.matchTargetScore.value = 3;
  els.formatSelect.value = "double-elimination";
  updateRuleNote();
  renderPlayerNameInputs();
  els.standings.innerHTML = "";
  els.matches.className = "schedule-board empty-state";
  els.matches.textContent = "暂无比赛";
  els.roundTitle.textContent = "赛程";
  els.roundNote.textContent = "创建赛程后开始记录。";
  els.roundMetric.textContent = "-";
  els.activeMetric.textContent = "0";
  els.advancedMetric.textContent = "0";
  els.eliminatedMetric.textContent = "0";
  els.nextRoundBtn.disabled = true;
  els.saveStatus.textContent = "未创建";
}

function renderMetrics() {
  const counts = countStatuses();
  els.roundMetric.textContent = state.currentRound || "-";
  els.activeMetric.textContent = counts.active;
  els.advancedMetric.textContent = counts.advanced;
  els.eliminatedMetric.textContent = counts.eliminated;
}

function renderStandings() {
  els.standings.innerHTML = "";
  const fragment = document.createDocumentFragment();
  [...state.players].sort(sortByRecordThenName).forEach((player) => {
    const row = document.createElement("div");
    row.className = "standing-row";
    row.innerHTML = `
      <div>
        <strong></strong>
        <span></span>
      </div>
      <div class="status-chip"></div>
    `;
    row.querySelector("strong").textContent = player.name;
    const totalScoreText =
      (state.format || "double-elimination") === "round-robin"
        ? ` · 总分 ${playerTotalScore(player.id)}/${state.settings.matchTargetScore}`
        : "";
    row.querySelector("span").textContent = `${player.wins}胜 ${player.losses}负${totalScoreText}${player.bye ? " · 已轮空" : ""}`;
    const chip = row.querySelector(".status-chip");
    chip.textContent = statusText(player.status);
    chip.classList.add(`status-${player.status}`);
    fragment.append(row);
  });
  els.standings.append(fragment);
}

function renderRound() {
  const round = currentRound();
  els.roundTitle.textContent = round ? `${round.title || `第 ${round.number} 轮`}赛程` : "赛程";

  if (!round) {
    els.matches.className = "schedule-board empty-state";
    els.matches.textContent = "暂无比赛";
    els.roundNote.textContent = "创建赛程后开始记录。";
    els.nextRoundBtn.disabled = true;
    return;
  }

  const complete = isRoundComplete(round);
  const hasNextRound = Boolean(complete && buildNextRound());
  els.roundNote.textContent = complete
    ? hasNextRound
      ? "本轮已完成，可以生成下一轮。"
      : "赛事已结束。"
    : "填写比分、英雄，并点选胜者。";
  els.nextRoundBtn.disabled = !complete || !hasNextRound;

  els.matches.className = `schedule-board format-${state.format || "double-elimination"}`;
  els.matches.innerHTML = "";
  els.matches.append(renderBracketBoard());
}

function renderMatchCard(round, match) {
  const node = els.matchTemplate.content.firstElementChild.cloneNode(true);
  const playerA = findPlayer(match.playerAId);
  const playerB = findPlayer(match.playerBId);
  node.classList.toggle("is-complete", Boolean(match.winnerId));
  node.dataset.matchId = match.id;
  node.classList.add(`bracket-${bracketClass(match.bracket)}`);
  node.querySelector(".match-title").textContent = `${match.code || `桌 ${match.table}`} · ${match.title || "对局"}`;
  node.querySelector(".record-label").textContent = `${match.bracket || "赛程"} · ${playerRecordBeforeRound(playerA, round.number)} vs ${playerRecordBeforeRound(playerB, round.number)}`;
  fillPlayerRow(
    node.querySelector('[data-side="a"]'),
    playerA,
    match.heroA,
    match.scoreA,
    match.winnerId === playerA.id
  );
  fillPlayerRow(
    node.querySelector('[data-side="b"]'),
    playerB,
    match.heroB,
    match.scoreB,
    match.winnerId === playerB.id
  );

  node.querySelector('[data-side="a"] .hero-input').addEventListener("input", (event) => {
    match.heroA = event.target.value;
    saveState();
    renderHistory();
  });
  node.querySelector('[data-side="b"] .hero-input').addEventListener("input", (event) => {
    match.heroB = event.target.value;
    saveState();
    renderHistory();
  });
  node.querySelector('[data-side="a"] .score-input').addEventListener("input", (event) => {
    match.scoreA = clampNumber(event.target.value, 0, 99);
    enforceWinningScore(match);
    saveState();
    render();
  });
  node.querySelector('[data-side="b"] .score-input').addEventListener("input", (event) => {
    match.scoreB = clampNumber(event.target.value, 0, 99);
    enforceWinningScore(match);
    saveState();
    render();
  });
  node.querySelector(".winner-a").addEventListener("click", () => setWinner(round, match, playerA.id));
  node.querySelector(".winner-b").addEventListener("click", () => setWinner(round, match, playerB.id));
  node.querySelector(".clear-match").addEventListener("click", () => clearMatch(round, match));
  const locked = round.number !== currentRound()?.number;
  node.querySelectorAll("input, button").forEach((control) => {
    control.disabled = locked;
  });
  return node;
}

function renderBracketBoard() {
  if ((state.format || "double-elimination") === "double-elimination") {
    return renderDoubleEliminationBoard();
  }
  const board = document.createElement("div");
  board.className = "bracket-board";
  const fragment = document.createDocumentFragment();

  state.rounds.forEach((round) => {
    const column = document.createElement("section");
    column.className = "round-column";
    column.style.setProperty("--match-count", round.matches.length || 1);
    column.innerHTML = `
      <div class="round-column__title">
        <strong></strong>
        <span></span>
      </div>
      <div class="round-column__matches"></div>
    `;
    column.querySelector("strong").textContent = round.title || `第 ${round.number} 轮`;
    column.querySelector("span").textContent = `${round.matches.length} 场`;
    const list = column.querySelector(".round-column__matches");
    round.matches.forEach((match) => {
      const wrap = document.createElement("div");
      wrap.className = "bracket-slot";
      wrap.classList.toggle("has-next", hasNextRoundMatch(round, match));
      wrap.append(renderMatchCard(round, match));
      list.append(wrap);
    });
    fragment.append(column);
  });

  board.append(fragment);
  return board;
}

function renderDoubleEliminationBoard() {
  const board = document.createElement("div");
  board.className = "de-board";
  const lanes = [
    ["胜者组", "winners"],
    ["败者组", "losers"],
    ["总决赛", "final"],
  ];
  lanes.forEach(([label, key]) => {
    const lane = document.createElement("section");
    lane.className = `de-lane de-lane-${key}`;
    lane.innerHTML = `<div class="de-lane__title">${label}</div><div class="de-lane__matches"></div>`;
    const matchesEl = lane.querySelector(".de-lane__matches");
    state.rounds.forEach((round) => {
      const laneMatches = round.matches.filter((match) => bracketClass(match.bracket) === key);
      if (!laneMatches.length) return;
      const stack = document.createElement("div");
      stack.className = "de-round-stack";
      stack.dataset.round = round.number;
      laneMatches.forEach((match) => {
        const slot = document.createElement("div");
        slot.className = "bracket-slot";
        slot.append(renderMatchCard(round, match));
        stack.append(slot);
      });
      matchesEl.append(stack);
    });
    board.append(lane);
  });
  return board;
}

function renderPlayerNameInputs(names = getPlayerNameInputs()) {
  const count = clampNumber(els.playerCount.value, 2, 32);
  const playerNames = appData.settings.playerNames;
  const currentNames = names.length ? names : getPlayerNameInputs();
  els.playerNameGrid.innerHTML = "";
  const fragment = document.createDocumentFragment();

  Array.from({ length: count }, (_, index) => {
    const label = document.createElement("label");
    label.className = "player-name-field";
    label.innerHTML = `
      <span></span>
      <select class="player-name-input"></select>
    `;
    label.querySelector("span").textContent = `选手 ${index + 1}`;
    const input = label.querySelector("select");
    input.append(new Option("请选择", ""));
    playerNames.forEach((name) => input.append(new Option(name, name)));
    if (currentNames[index] && !playerNames.includes(currentNames[index])) {
      input.append(new Option(currentNames[index], currentNames[index]));
    }
    input.value = currentNames[index] || playerNames[index] || "";
    fragment.append(label);
  });

  els.playerNameGrid.append(fragment);
}

function getPlayerNameInputs() {
  return [...els.playerNameGrid.querySelectorAll(".player-name-input")].map((input) =>
    input.value.trim()
  );
}

function renderHistory() {
  const archives = appData.history;
  renderHistoryViewTabs();
  renderAdminHistoryList();
  els.historyPage.classList.toggle("is-stats-view", historyView === "stats");
  if (!archives.length) {
    els.historySummary.innerHTML = "";
    els.historyList.className = "history-list empty-state";
    els.historyList.textContent = "暂无记录";
    els.historyPagination.innerHTML = "";
    els.historyDetail.className = "history-detail empty-state";
    els.historyDetail.textContent = "暂无历史赛程";
    els.historyNote.textContent = "创建新赛程时，上一套完整赛程会自动归档到这里。";
    return;
  }

  const matchTotal = archives.reduce((total, archive) => total + flattenMatches(archive).length, 0);
  els.historyNote.textContent = `已归档 ${archives.length} 套赛程，${matchTotal} 场比赛`;
  els.historySummary.innerHTML = `<span>${archives.length} 套历史赛程</span>`;

  const maxPage = Math.max(1, Math.ceil(archives.length / HISTORY_PAGE_SIZE));
  historyPageIndex = Math.min(maxPage, Math.max(1, historyPageIndex));
  if (!archives.some((archive) => archive.id === selectedHistoryId)) {
    selectedHistoryId = archives[(historyPageIndex - 1) * HISTORY_PAGE_SIZE]?.id || archives[0].id;
  }

  const pageStart = (historyPageIndex - 1) * HISTORY_PAGE_SIZE;
  const pageItems = archives.slice(pageStart, pageStart + HISTORY_PAGE_SIZE);

  els.historyList.className = "history-list";
  els.historyList.innerHTML = "";
  const fragment = document.createDocumentFragment();
  pageItems.forEach((archive, index) => {
    fragment.append(renderHistoryListItem(archive, pageStart + index));
  });
  els.historyList.append(fragment);
  renderHistoryPagination(maxPage);
  renderHistoryDetail();
}

function renderHistoryListItem(archive, index) {
  const item = document.createElement("article");
  item.className = "history-list-item";
  item.classList.toggle("is-selected", archive.id === selectedHistoryId);
  item.innerHTML = `
    <button type="button" class="history-select">
      <strong></strong>
      <span></span>
    </button>
  `;
  item.querySelector("strong").textContent = archive.name || `历史赛程 ${appData.history.length - index}`;
  item.querySelector("span").textContent = `${formatDateTime(archive.archivedAt || archive.createdAt)} · ${archive.rounds.length} 轮 · ${flattenMatches(archive).length} 场`;
  item.querySelector(".history-select").addEventListener("click", () => {
    selectedHistoryId = archive.id;
    renderHistory();
  });
  return item;
}

function renderHistoryViewTabs() {
  els.historyViewTabs.forEach((tab) => {
    tab.classList.toggle("is-selected", tab.dataset.historyView === historyView);
  });
}

function renderHistoryPagination(maxPage) {
  els.historyPagination.innerHTML = "";
  if (maxPage <= 1) return;
  const prev = document.createElement("button");
  const status = document.createElement("span");
  const next = document.createElement("button");
  prev.type = "button";
  next.type = "button";
  prev.textContent = "上一页";
  next.textContent = "下一页";
  prev.disabled = historyPageIndex === 1;
  next.disabled = historyPageIndex === maxPage;
  status.textContent = `${historyPageIndex} / ${maxPage}`;
  prev.addEventListener("click", () => {
    historyPageIndex -= 1;
    selectedHistoryId = appData.history[(historyPageIndex - 1) * HISTORY_PAGE_SIZE]?.id || selectedHistoryId;
    renderHistory();
  });
  next.addEventListener("click", () => {
    historyPageIndex += 1;
    selectedHistoryId = appData.history[(historyPageIndex - 1) * HISTORY_PAGE_SIZE]?.id || selectedHistoryId;
    renderHistory();
  });
  els.historyPagination.append(prev, status, next);
}

function renderHistoryDetail() {
  if (historyView === "stats") {
    renderHistoryStats();
    return;
  }
  const archive = appData.history.find((item) => item.id === selectedHistoryId);
  if (!archive) {
    els.historyDetail.className = "history-detail empty-state";
    els.historyDetail.textContent = "请选择左侧赛程";
    return;
  }
  els.historyDetail.className = "history-detail";
  els.historyDetail.innerHTML = "";
  els.historyDetail.append(renderHistoryTournament(archive));
}

function renderHistoryStats() {
  const stats = buildHistoryStats(appData.history);
  if (!stats.players.length) {
    els.historyDetail.className = "history-detail empty-state";
    els.historyDetail.textContent = "暂无可统计的已完成比赛";
    return;
  }

  if (!selectedStatsPlayerName || !stats.players.some((player) => player.name === selectedStatsPlayerName)) {
    selectedStatsPlayerName = stats.players[0].name;
  }
  const selectedPlayer = stats.players.find((player) => player.name === selectedStatsPlayerName);

  els.historyDetail.className = "history-detail";
  els.historyDetail.innerHTML = "";
  const panel = document.createElement("article");
  panel.className = "stats-panel";
  panel.innerHTML = `
    <div class="stats-panel__head">
      <div>
        <strong>选手胜率统计</strong>
        <span></span>
      </div>
      <label class="stats-player-picker">
        <span>选择选手</span>
        <select></select>
      </label>
    </div>
    <div class="stats-selected"></div>
  `;
  panel.querySelector("span").textContent = `${stats.matchCount} 场已完成比赛 · ${stats.players.length} 名选手`;
  const select = panel.querySelector(".stats-player-picker select");
  stats.players.forEach((player) => select.append(new Option(player.name, player.name)));
  select.value = selectedStatsPlayerName;
  select.addEventListener("change", (event) => {
    selectedStatsPlayerName = event.target.value;
    renderHistoryStats();
  });
  panel.querySelector(".stats-selected").append(renderPlayerStats(selectedPlayer));
  els.historyDetail.append(panel);
}

function renderPlayerStats(player) {
  const card = document.createElement("section");
  card.className = "player-stats-card";
  card.innerHTML = `
    <div class="player-stats-card__head">
      <div>
        <strong></strong>
        <span></span>
      </div>
      <b></b>
    </div>
    <div class="stats-subgrid">
      <div>
        <h3>英雄</h3>
        <div class="mini-table hero-stats"></div>
      </div>
      <div>
        <h3>对手</h3>
        <div class="mini-table opponent-stats"></div>
      </div>
    </div>
  `;
  card.querySelector(".player-stats-card__head strong").textContent = player.name;
  card.querySelector(".player-stats-card__head span").textContent = `${player.wins} 胜 ${player.losses} 负`;
  card.querySelector(".player-stats-card__head b").textContent = formatPercent(player.wins, player.games);

  const heroStats = [...player.heroes.entries()]
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.games - a.games || b.wins - a.wins || a.name.localeCompare(b.name, "zh-CN"));
  const opponentStats = [...player.opponents.entries()]
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.games - a.games || b.wins - a.wins || a.name.localeCompare(b.name, "zh-CN"));

  fillMiniTable(card.querySelector(".hero-stats"), heroStats, "暂无英雄记录", (item) => [
    item.name,
    `${item.games} 次`,
    `${item.wins} 胜`,
    formatPercent(item.wins, item.games),
  ]);
  fillMiniTable(card.querySelector(".opponent-stats"), opponentStats, "暂无交手记录", (item) => [
    item.name,
    `${item.wins}-${item.losses}`,
    `${item.games} 场`,
    formatPercent(item.wins, item.games),
  ]);
  return card;
}

function fillMiniTable(container, items, emptyText, toCells) {
  container.innerHTML = "";
  if (!items.length) {
    container.classList.add("empty-mini-table");
    container.textContent = emptyText;
    return;
  }
  container.classList.remove("empty-mini-table");
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "mini-table-row";
    toCells(item).forEach((value) => {
      const cell = document.createElement("span");
      cell.textContent = value;
      row.append(cell);
    });
    container.append(row);
  });
}

function buildHistoryStats(archives) {
  const players = new Map();
  let matchCount = 0;

  const ensurePlayer = (name) => {
    const key = name || "未知选手";
    if (!players.has(key)) {
      players.set(key, { name: key, games: 0, wins: 0, losses: 0, heroes: new Map(), opponents: new Map() });
    }
    return players.get(key);
  };

  const ensureCounter = (map, key) => {
    const safeKey = key || "未记录";
    if (!map.has(safeKey)) map.set(safeKey, { games: 0, wins: 0, losses: 0 });
    return map.get(safeKey);
  };

  archives.forEach((archive) => {
    archive.rounds.forEach((round) => {
      round.matches.forEach((match) => {
        if (!match.winnerId) return;
        const playerA = findArchivedPlayer(archive, match.playerAId);
        const playerB = findArchivedPlayer(archive, match.playerBId);
        if (!playerA || !playerB) return;
        matchCount += 1;

        [
          [playerA, playerB, match.heroA, match.winnerId === playerA.id],
          [playerB, playerA, match.heroB, match.winnerId === playerB.id],
        ].forEach(([player, opponent, hero, won]) => {
          const row = ensurePlayer(player.name);
          row.games += 1;
          row.wins += won ? 1 : 0;
          row.losses += won ? 0 : 1;

          const heroRow = ensureCounter(row.heroes, hero?.trim() || "未记录英雄");
          heroRow.games += 1;
          heroRow.wins += won ? 1 : 0;
          heroRow.losses += won ? 0 : 1;

          const opponentRow = ensureCounter(row.opponents, opponent.name);
          opponentRow.games += 1;
          opponentRow.wins += won ? 1 : 0;
          opponentRow.losses += won ? 0 : 1;
        });
      });
    });
  });

  return {
    matchCount,
    players: [...players.values()].sort((a, b) => b.wins - a.wins || b.games - a.games || a.name.localeCompare(b.name, "zh-CN")),
  };
}

function renderHistoryTournament(archive) {
  const card = document.createElement("article");
  card.className = "history-tournament";
  const counts = countArchivedStatuses(archive);
  const matchCount = flattenMatches(archive).length;
  card.innerHTML = `
    <div class="history-tournament__head">
      <div>
        <strong></strong>
        <span></span>
      </div>
      <b></b>
    </div>
    <div class="history-tournament__summary"></div>
    <div class="history-tournament__rounds"></div>
  `;

  card.querySelector(".history-tournament__head strong").textContent = archive.name || "未命名赛程";
  card.querySelector(".history-tournament__head span").textContent = formatDateTime(archive.archivedAt || archive.createdAt);
  card.querySelector(".history-tournament__head b").textContent = `${archive.players.length} 人`;
  card.querySelector(".history-tournament__summary").textContent =
    `${archive.rounds.length} 轮 · ${matchCount} 场 · 晋级 ${counts.advanced} · 淘汰 ${counts.eliminated}`;

  const roundsEl = card.querySelector(".history-tournament__rounds");
  archive.rounds.forEach((round) => roundsEl.append(renderHistoryRound(archive, round)));
  return card;
}

function renderHistoryRound(archive, round) {
  const group = document.createElement("section");
  group.className = "history-round";
  group.innerHTML = `
    <div class="history-round__title">
      <strong></strong>
      <span></span>
    </div>
    <div class="history-round__matches"></div>
  `;
  group.querySelector("strong").textContent = round.title || `第 ${round.number} 轮`;
  group.querySelector("span").textContent = `${round.matches.length} 场`;
  const list = group.querySelector(".history-round__matches");
  round.matches.forEach((match) => list.append(renderHistoryItem(archive, round, match)));
  return group;
}

function renderHistoryItem(archive, round, match) {
  const playerA = findArchivedPlayer(archive, match.playerAId);
  const playerB = findArchivedPlayer(archive, match.playerBId);
  const winner = match.winnerId ? findArchivedPlayer(archive, match.winnerId) : null;
  const item = document.createElement("article");
  item.className = "history-item";
  item.innerHTML = `
    <div class="history-item__meta">
      <strong></strong>
      <span></span>
    </div>
    <div class="history-player" data-side="a">
      <strong></strong>
      <span></span>
      <b></b>
    </div>
    <div class="history-player" data-side="b">
      <strong></strong>
      <span></span>
      <b></b>
    </div>
    <div class="history-result"></div>
  `;

  item.querySelector(".history-item__meta strong").textContent = `${match.code || `桌 ${match.table}`} · ${match.title || "对局"}`;
  item.querySelector(".history-item__meta span").textContent = `${match.bracket || "赛程"} · ${archivedPlayerRecordBeforeRound(archive, playerA, round.number)} vs ${archivedPlayerRecordBeforeRound(archive, playerB, round.number)}`;
  fillHistoryPlayer(item.querySelector('[data-side="a"]'), playerA, match.heroA, match.scoreA, match.winnerId === playerA.id);
  fillHistoryPlayer(item.querySelector('[data-side="b"]'), playerB, match.heroB, match.scoreB, match.winnerId === playerB.id);
  item.querySelector(".history-result").textContent = winner ? `胜者：${winner.name}` : "胜者待定";
  return item;
}

function fillHistoryPlayer(row, player, hero, score, isWinner) {
  row.classList.toggle("is-winner", isWinner);
  row.querySelector("strong").textContent = player.name;
  row.querySelector("span").textContent = hero || "未记录英雄";
  row.querySelector("b").textContent = score;
}

function flattenMatches(tournament = state) {
  return tournament.rounds.flatMap((round) => round.matches.map((match) => ({ round, match })));
}

function findMatchByCode(code) {
  return state.rounds.flatMap((round) => round.matches).find((match) => match.code === code);
}

function loserId(match) {
  if (!match?.winnerId) return null;
  return match.winnerId === match.playerAId ? match.playerBId : match.playerAId;
}

function bracketClass(bracket) {
  if (bracket === "胜者组") return "winners";
  if (bracket === "败者组") return "losers";
  if (bracket === "总决赛") return "final";
  return "neutral";
}

function championId() {
  if ((state.format || "double-elimination") === "round-robin") {
    const targetWinner = targetWinnerId();
    if (targetWinner) return targetWinner;
  }
  if ((state.format || "double-elimination") === "single-elimination") {
    const participants = state.rounds.length && state.rounds.every(isRoundComplete) ? singleEliminationParticipants() : [];
    return participants.length === 1 ? participants[0] : null;
  }
  const roundRobinRoundCount = state.players.length % 2 === 0 ? state.players.length - 1 : state.players.length;
  if ((state.format || "double-elimination") === "round-robin" && state.rounds.length === roundRobinRoundCount && state.rounds.every(isRoundComplete)) {
    return [...state.players].sort(sortByRecordThenName)[0]?.id || null;
  }
  if ((state.format || "double-elimination") === "swiss" && state.rounds.length === 3 && state.rounds.every(isRoundComplete)) {
    return [...state.players].sort(sortByRecordThenName)[0]?.id || null;
  }
  const reset = findMatchByCode("RESET");
  if (reset?.winnerId) return reset.winnerId;
  const gf1 = findMatchByCode("GF1");
  const l2 = findMatchByCode("L2");
  if (gf1?.winnerId && gf1.winnerId !== l2?.winnerId) return gf1.winnerId;
  return null;
}

function targetWinnerId() {
  const targetScore = clampNumber(state.settings?.matchTargetScore ?? 3, 1, 99);
  const leaders = state.players
    .map((player) => ({ ...player, totalScore: playerTotalScore(player.id) }))
    .filter((player) => player.totalScore >= targetScore)
    .sort((a, b) => b.totalScore - a.totalScore || sortByRecordThenName(a, b));
  return leaders[0]?.id || null;
}

function playerTotalScore(playerId, tournament = state) {
  if (!tournament) return 0;
  return flattenMatches(tournament).reduce((total, { match }) => {
    if (!match.winnerId) return total;
    if (match.playerAId === playerId) return total + clampNumber(match.scoreA, 0, 99);
    if (match.playerBId === playerId) return total + clampNumber(match.scoreB, 0, 99);
    return total;
  }, 0);
}

function playerRecordBeforeRound(player, roundNumber) {
  let wins = 0;
  let losses = 0;
  for (const round of state.rounds) {
    if (round.number >= roundNumber) break;
    for (const match of round.matches) {
      if (match.playerAId !== player.id && match.playerBId !== player.id) continue;
      if (!match.winnerId) continue;
      if (match.winnerId === player.id) wins += 1;
      else losses += 1;
    }
  }
  return `${wins}-${losses}`;
}

function archivedPlayerRecordBeforeRound(archive, player, roundNumber) {
  let wins = 0;
  let losses = 0;
  for (const round of archive.rounds) {
    if (round.number >= roundNumber) break;
    for (const match of round.matches) {
      if (match.playerAId !== player.id && match.playerBId !== player.id) continue;
      if (!match.winnerId) continue;
      if (match.winnerId === player.id) wins += 1;
      else losses += 1;
    }
  }
  return `${wins}-${losses}`;
}

function hasNextRoundMatch(round, match) {
  const nextRound = state.rounds.find((candidate) => candidate.number === round.number + 1);
  if (!nextRound || !match.winnerId) return false;
  return nextRound.matches.some(
    (nextMatch) => nextMatch.playerAId === match.winnerId || nextMatch.playerBId === match.winnerId
  );
}

function fillPlayerRow(row, player, hero, score, isWinner) {
  row.classList.toggle("is-winner", isWinner);
  row.querySelector(".player-name").textContent = player.name;
  row.querySelector(".hero-input").value = hero;
  row.querySelector(".score-input").value = score;
}

function setWinner(round, match, winnerId) {
  if (match.winnerId) revertMatchResult(match);
  const loserId = winnerId === match.playerAId ? match.playerBId : match.playerAId;
  const winner = findPlayer(winnerId);
  const loser = findPlayer(loserId);

  match.winnerId = winnerId;
  enforceWinningScore(match);

  winner.wins += 1;
  loser.losses += 1;
  winner.previousOpponents.push(loser.id);
  loser.previousOpponents.push(winner.id);
  updatePlayerStatuses();
  saveAndRender();
}

function enforceWinningScore(match) {
  if (!match.winnerId) return;
  if (match.winnerId === match.playerAId) {
    match.scoreA = Math.max(match.scoreA, state.settings.targetScore, match.scoreB + 1);
  }
  if (match.winnerId === match.playerBId) {
    match.scoreB = Math.max(match.scoreB, state.settings.targetScore, match.scoreA + 1);
  }
}

function clearMatch(round, match) {
  if (match.winnerId) revertMatchResult(match);
  match.heroA = "";
  match.heroB = "";
  match.scoreA = 0;
  match.scoreB = 0;
  updatePlayerStatuses();
  saveAndRender();
}

function revertMatchResult(match) {
  const winner = findPlayer(match.winnerId);
  const loser = findPlayer(match.winnerId === match.playerAId ? match.playerBId : match.playerAId);
  winner.wins -= 1;
  loser.losses -= 1;
  winner.previousOpponents = winner.previousOpponents.filter((id) => id !== loser.id);
  loser.previousOpponents = loser.previousOpponents.filter((id) => id !== winner.id);
  match.winnerId = null;
}

function updatePlayerStatuses() {
  if ((state.format || "double-elimination") === "round-robin" || (state.format || "double-elimination") === "swiss") {
    const champion = championId();
    state.players.forEach((player) => {
      player.status = champion === player.id ? "advanced" : "active";
    });
    return;
  }
  if ((state.format || "double-elimination") === "single-elimination") {
    const champion = championId();
    const eliminated = new Set(flattenMatches().filter(({ match }) => match.winnerId).map(({ match }) => loserId(match)));
    state.players.forEach((player) => {
      if (champion === player.id) player.status = "advanced";
      else if (eliminated.has(player.id)) player.status = "eliminated";
      else player.status = "active";
    });
    return;
  }
  const champion = championId();
  state.players.forEach((player) => {
    if (champion === player.id) {
      player.status = "advanced";
    } else if (player.losses >= DOUBLE_ELIMINATION_LOSSES || champion) {
      player.status = "eliminated";
    } else {
      player.status = "active";
    }
  });
}

function currentRound() {
  return state?.rounds[state.rounds.length - 1] || null;
}

function isRoundComplete(round) {
  return Boolean(round) && round.matches.every((match) => match.winnerId);
}

function findPlayer(id) {
  return state.players.find((player) => player.id === id);
}

function findArchivedPlayer(archive, id) {
  return archive.players.find((player) => player.id === id);
}

function countStatuses() {
  return state.players.reduce(
    (counts, player) => {
      counts[player.status] += 1;
      return counts;
    },
    { active: 0, advanced: 0, eliminated: 0 }
  );
}

function countArchivedStatuses(archive) {
  return archive.players.reduce(
    (counts, player) => {
      counts[player.status] += 1;
      return counts;
    },
    { active: 0, advanced: 0, eliminated: 0 }
  );
}

async function deleteHistoryTournament(id) {
  if (!adminSession) return;
  const archive = appData.history.find((item) => item.id === id);
  if (!archive || !window.confirm(`确定删除「${archive.name || "未命名赛程"}」吗？`)) return;
  const result = await deleteRemoteHistory(id, adminSession);
  if (!result.ok) {
    window.alert(result.message || "删除失败，请检查管理员账号或网络。");
    return;
  }
  appData.history = appData.history.filter((archive) => archive.id !== id);
  const maxPage = Math.max(1, Math.ceil(appData.history.length / HISTORY_PAGE_SIZE));
  historyPageIndex = Math.min(historyPageIndex, maxPage);
  selectedHistoryId = appData.history[(historyPageIndex - 1) * HISTORY_PAGE_SIZE]?.id || appData.history[0]?.id || null;
  saveState();
  renderHistory();
  renderAdminHistoryList();
  window.alert("历史赛程已删除。");
}

async function loginAdmin(event) {
  event.preventDefault();
  els.adminLoginError.textContent = "";
  const credentials = {
    username: els.adminUsername.value.trim(),
    password: els.adminPassword.value,
  };
  const result = await verifyAdmin(credentials);
  if (!result.ok) {
    els.adminLoginError.textContent = result.message || "登录失败。";
    return;
  }
  adminSession = credentials;
  els.adminPassword.value = "";
  renderAdmin();
}

function logoutAdmin() {
  adminSession = null;
  els.adminPassword.value = "";
  renderAdmin();
}

function renderAdmin() {
  const signedIn = Boolean(adminSession);
  els.adminLoginForm.classList.toggle("is-hidden", signedIn);
  els.adminTools.classList.toggle("is-hidden", !signedIn);
  els.adminLogout.classList.toggle("is-hidden", !signedIn);
  if (!signedIn) return;
  els.adminPlayerList.value = appData.settings.playerNames.join("\n");
  renderAdminHistoryList();
}

function renderAdminHistoryList() {
  if (!els.adminHistoryList || !adminSession) return;
  if (!appData.history.length) {
    els.adminHistoryList.className = "admin-history-list empty-state";
    els.adminHistoryList.textContent = "暂无记录";
    return;
  }
  els.adminHistoryList.className = "admin-history-list";
  els.adminHistoryList.innerHTML = "";
  appData.history.forEach((archive) => {
    const row = document.createElement("article");
    row.className = "admin-history-item";
    row.innerHTML = `
      <div>
        <strong></strong>
        <span></span>
      </div>
      <button type="button" class="history-delete">删除</button>
    `;
    row.querySelector("strong").textContent = archive.name || "未命名赛程";
    row.querySelector("span").textContent = `${formatDateTime(archive.archivedAt || archive.createdAt)} · ${archive.rounds.length} 轮 · ${flattenMatches(archive).length} 场`;
    row.querySelector("button").addEventListener("click", () => deleteHistoryTournament(archive.id));
    els.adminHistoryList.append(row);
  });
}

async function saveAdminPlayerList() {
  if (!adminSession) return;
  const names = normalizePlayerNames(els.adminPlayerList.value.split(/\n+/));
  if (!names.length) {
    window.alert("预设选手名单不能为空。");
    return;
  }
  const result = await saveRemoteConfig({ playerNames: names }, adminSession);
  if (!result.ok) {
    window.alert(result.message || "保存失败，请检查管理员账号或网络。");
    return;
  }
  appData.settings.playerNames = names;
  saveState();
  renderPlayerNameInputs();
  renderAdmin();
  window.alert("预设选手名单已保存。");
}

function sortByRecordThenName(a, b) {
  return b.wins - a.wins || a.losses - b.losses || a.name.localeCompare(b.name, "zh-CN");
}

function statusText(status) {
  return {
    active: "在赛",
    advanced: "晋级",
    eliminated: "淘汰",
  }[status];
}

function clampNumber(value, min, max) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function saveAndRender() {
  saveState();
  render();
}

function saveState() {
  appData.current = state;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
}

async function syncRemoteHistory() {
  try {
    const response = await fetch(RECORDS_API, { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const data = await response.json();
    if (Array.isArray(data.settings?.playerNames)) {
      appData.settings.playerNames = normalizePlayerNames(data.settings.playerNames);
      renderPlayerNameInputs();
    }
    if (!Array.isArray(data.history)) return;
    const remoteHistory = data.history.map(normalizeTournament).filter(Boolean);
    appData.history = remoteHistory.slice(0, 200);
    if (!selectedHistoryId || !appData.history.some((record) => record.id === selectedHistoryId)) {
      selectedHistoryId = appData.history[0]?.id || null;
    }
    saveState();
    renderHistory();
  } catch {
    // Local storage remains available when the cloud API is unreachable.
  }
}

async function verifyAdmin(credentials) {
  if (isLocalFrontend() && isLocalAdmin(credentials)) {
    return { ok: true };
  }
  try {
    const response = await fetch(`${RECORDS_API}?action=admin-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, message: data.error || "登录失败，请检查账号密码。" };
    return { ok: true };
  } catch {
    if (isLocalFrontend() && isLocalAdmin(credentials)) return { ok: true };
    return { ok: false, message: "登录失败，请检查网络连接或 Netlify Functions 是否可用。" };
  }
}

async function saveRemoteConfig(settings, credentials) {
  if (isLocalFrontend() && isLocalAdmin(credentials)) {
    appData.settings = normalizeSettings(settings);
    return { ok: true };
  }
  try {
    const response = await fetch(`${RECORDS_API}?action=settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...credentials, settings }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, message: data.error || "保存失败。" };
    if (Array.isArray(data.settings?.playerNames)) {
      appData.settings.playerNames = normalizePlayerNames(data.settings.playerNames);
    }
    return { ok: true };
  } catch {
    if (isLocalFrontend() && isLocalAdmin(credentials)) {
      appData.settings = normalizeSettings(settings);
      return { ok: true };
    }
    return { ok: false, message: "保存失败，请检查网络连接。" };
  }
}

async function postRemoteHistory(record) {
  try {
    const response = await fetch(RECORDS_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record }),
    });
    if (!response.ok) return;
    const data = await response.json();
    if (Array.isArray(data.history)) {
      appData.history = data.history.map(normalizeTournament).filter(Boolean);
    }
  } catch {
    // Keep the local archive if the cloud API is unreachable.
  }
}

async function deleteRemoteHistory(id, credentials) {
  if (isLocalFrontend() && isLocalAdmin(credentials)) {
    appData.history = appData.history.filter((archive) => archive.id !== id);
    return { ok: true };
  }
  try {
    const response = await fetch(RECORDS_API, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...credentials }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, message: data.error || "删除失败，请检查管理员账号或网络。" };
    if (Array.isArray(data.history)) {
      appData.history = data.history.map(normalizeTournament).filter(Boolean);
    }
    return { ok: true };
  } catch {
    if (isLocalFrontend() && isLocalAdmin(credentials)) {
      appData.history = appData.history.filter((archive) => archive.id !== id);
      return { ok: true };
    }
    return { ok: false, message: "删除失败，请检查网络连接。" };
  }
}

function loadAppData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { current: null, history: [], settings: defaultSettings() };
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.history) && Object.prototype.hasOwnProperty.call(parsed, "current")) {
      return {
        current: normalizeTournament(parsed.current || null),
        history: (parsed.history || []).map(normalizeTournament).filter(Boolean),
        settings: normalizeSettings(parsed.settings),
      };
    }
    return { current: normalizeTournament(parsed), history: [], settings: defaultSettings() };
  } catch {
    return { current: null, history: [], settings: defaultSettings() };
  }
}

function defaultSettings() {
  return { playerNames: [...DEFAULT_PLAYER_NAMES] };
}

function normalizeSettings(settings = {}) {
  return {
    playerNames: normalizePlayerNames(settings.playerNames),
  };
}

function normalizePlayerNames(names = []) {
  const list = Array.isArray(names) ? names : [];
  const seen = new Set();
  const normalized = [];
  list.forEach((name) => {
    const value = String(name || "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    normalized.push(value);
  });
  return normalized.length ? normalized : [...DEFAULT_PLAYER_NAMES];
}

async function archiveCurrentTournament() {
  if (!state || !state.rounds.length) return;
  const record = {
    ...structuredClone(state),
    name: state.name || normalizeTournamentName("", state.format || "double-elimination"),
    archivedAt: new Date().toISOString(),
  };
  appData.history.unshift(record);
  appData.history = appData.history.slice(0, 200);
  await postRemoteHistory(record);
}

function normalizeTournament(tournament) {
  if (!tournament) return null;
  const normalized = {
    ...tournament,
    id: tournament.id || crypto.randomUUID(),
    name: tournament.name || normalizeTournamentName("", tournament.format || "double-elimination"),
    createdAt: tournament.createdAt || new Date().toISOString(),
    format: tournament.format || "double-elimination",
    rounds: tournament.rounds || [],
    players: tournament.players || [],
    settings: {
      ...(tournament.settings || {}),
      targetScore: clampNumber(tournament.settings?.targetScore ?? 1, 1, 99),
      matchTargetScore: clampNumber(tournament.settings?.matchTargetScore ?? 3, 1, 99),
      eliminateLosses: DOUBLE_ELIMINATION_LOSSES,
    },
  };
  normalized.rounds.forEach((round) => {
    round.matches = round.matches || [];
    round.matches.forEach((match) => {
      match.name = match.name || "";
    });
  });
  return normalized;
}

function updateRuleNote() {
  const [title, description] = FORMAT_COPY[els.formatSelect.value] || FORMAT_COPY["double-elimination"];
  els.ruleNote.querySelector("strong").textContent = title;
  els.ruleNote.querySelector("span").textContent = description;
  updateMatchTargetField();
}

function updateMatchTargetField() {
  const isRoundRobin = els.formatSelect.value === "round-robin";
  els.matchTargetField.classList.toggle("is-hidden", !isRoundRobin);
  els.matchTargetScore.disabled = !isRoundRobin;
}

function normalizeTournamentName(value, format = "double-elimination") {
  const trimmed = value.trim();
  return trimmed || `${FORMAT_COPY[format]?.[0] || "比赛"} ${formatDateTime(new Date().toISOString())}`;
}

function formatDateTime(value) {
  if (!value) return "未记录时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatPercent(wins, games) {
  if (!games) return "0%";
  return `${Math.round((wins / games) * 100)}%`;
}

function setPage(page) {
  currentPage = page;
  els.form.classList.toggle("is-hidden", currentPage !== "create");
  els.createPage.classList.toggle("is-hidden", currentPage !== "create");
  els.historyPage.classList.toggle("is-hidden", currentPage !== "history");
  els.adminPage.classList.toggle("is-hidden", currentPage !== "admin");
  els.navTabs.forEach((tab) => {
    tab.classList.toggle("is-selected", tab.dataset.page === currentPage);
  });
  els.adminEntry.classList.toggle("is-selected", currentPage === "admin");
  if (currentPage === "history") renderHistory();
  if (currentPage === "admin") renderAdmin();
}

els.form.addEventListener("submit", createTournament);
els.tournamentName.addEventListener("input", () => {
  if (!state) return;
  state.name = els.tournamentName.value.trim();
  saveState();
});
els.playerCount.addEventListener("input", () => renderPlayerNameInputs());
els.targetScore.addEventListener("input", () => {
  if (!state) return;
  state.settings.targetScore = clampNumber(els.targetScore.value, 1, 99);
  saveState();
});
els.matchTargetScore.addEventListener("input", () => {
  if (!state) return;
  state.settings.matchTargetScore = clampNumber(els.matchTargetScore.value, 1, 99);
  updatePlayerStatuses();
  saveAndRender();
});
els.formatSelect.addEventListener("change", updateRuleNote);
els.nextRoundBtn.addEventListener("click", generateNextRound);
els.navTabs.forEach((tab) => {
  tab.addEventListener("click", () => setPage(tab.dataset.page));
});
els.adminEntry.addEventListener("click", () => setPage("admin"));
els.historyViewTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    historyView = tab.dataset.historyView;
    renderHistory();
  });
});
els.adminLoginForm.addEventListener("submit", loginAdmin);
els.adminLogout.addEventListener("click", logoutAdmin);
els.savePlayerList.addEventListener("click", saveAdminPlayerList);
els.resetBtn.addEventListener("click", () => {
  appData.current = null;
  state = null;
  saveState();
  render();
});

setPage(currentPage);
render();
syncRemoteHistory();
