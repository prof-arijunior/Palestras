// Motor de enquetes ao vivo — lado do apresentador (tela grande).
// Lê slides com [data-poll="<id>"], desenha o QR code (biblioteca local, sem CDN)
// e escuta as respostas em tempo real no Firestore. Se a rede ou a autenticação
// falharem, cai em "modo exemplo" com números ilustrativos, para a palestra
// nunca travar numa tela vazia.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, setDoc, collection, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  projectId: "airo-financas-pessoais",
  appId: "1:365735742321:web:9fdeafd5a7d028a988c4d0",
  storageBucket: "airo-financas-pessoais.firebasestorage.app",
  apiKey: "AIzaSyD6Pqzq7Y24TQ-MiIUnLirGs9xlsLOaVaw",
  authDomain: "airo-financas-pessoais.firebaseapp.com",
  messagingSenderId: "365735742321"
};

const PARTICIPANT_BASE_URL = "https://airo-financas-pessoais.web.app/ao-vivo";
const SESSION_KEY = "salarioSumiu.sessionId";
const AUTH_TIMEOUT_MS = 4000;

const ACTIVITIES = [
  {
    // Moradia fica de fora de propósito: é o gasto óbvio (R$ 1.150, mais que o
    // dobro de qualquer outro) e votar nele tira a graça da aposta. Os 4
    // escolhidos aqui são os que mais se aproximam em valor — inclusive um
    // empate real entre mercado e parcelas — para a aposta ser genuína.
    id: "aposta",
    question: "Qual desses gastos pesa mais no orçamento do Nick (sem contar moradia)?",
    type: "choice",
    options: ["Alimentação e mercado", "Parcelas de compras", "Lazer e delivery", "Transporte"],
    example: [32, 29, 24, 15]
  },
  {
    id: "classificar",
    question: "Classifique os gastos do Nick",
    type: "classify",
    categories: ["Necessidades", "Desejos", "Futuro"],
    items: [
      { id: "aluguel", label: "Aluguel" },
      { id: "mercado", label: "Mercado" },
      { id: "transporte", label: "Transporte" },
      { id: "celular", label: "Celular e internet" },
      { id: "lazer", label: "Lazer e delivery" },
      { id: "assinaturas", label: "Assinaturas e outros" },
      { id: "ipva", label: "IPVA (uma vez por ano)" }
    ],
    // IPVA é o item de propósito: nenhum gasto do Nick é realmente "Futuro" (Futuro
    // não é despesa, é o que sobra), e boa parte da plateia ainda associa um gasto
    // sazonal a "guardar para depois" em vez de reconhecê-lo como Necessidade.
    example: {
      aluguel: [92, 6, 2], mercado: [88, 9, 3], transporte: [74, 20, 6],
      celular: [18, 76, 6], lazer: [4, 93, 3], assinaturas: [9, 85, 6],
      ipva: [55, 20, 25]
    }
  },
  {
    id: "prioridade",
    question: "Você está no lugar do Nick. Qual dívida você prioriza primeiro?",
    type: "choice",
    options: ["Cartão de crédito — R$ 300", "Celular parcelado — R$ 400", "Sofá novo — R$ 600", "Curso online — R$ 600", "Empréstimo pessoal — R$ 1.500"],
    example: [52, 18, 12, 10, 8]
  },
  {
    id: "termometro-nick",
    question: "Quão parecida é sua situação financeira com a do Nick?",
    type: "choice",
    options: [
      "1 · Nunca aperta, sempre sobra",
      "2 · Raramente aperta",
      "3 · Aperta de vez em quando",
      "4 · Aperta quase todo mês",
      "5 · É a minha realidade"
    ],
    example: [9, 18, 30, 26, 17]
  },
  {
    id: "termometro-reserva",
    question: "Quantos meses de reserva de emergência você tem hoje?",
    type: "choice",
    options: ["Nenhuma reserva", "1 a 2 meses", "3 a 5 meses", "6 meses ou mais"],
    example: [44, 29, 17, 10]
  }
];

function byId(id) { return ACTIVITIES.find(a => a.id === id); }

function getSessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function joinUrl(sessionId, activityId) {
  return `${PARTICIPANT_BASE_URL}?s=${encodeURIComponent(sessionId)}&a=${encodeURIComponent(activityId)}`;
}

function renderQR(container, url) {
  if (!container || !window.qrcode) return;
  try {
    const qr = window.qrcode(0, "M");
    qr.addData(url);
    qr.make();
    container.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2 });
    const svg = container.querySelector("svg");
    if (svg) { svg.style.width = "100%"; svg.style.height = "100%"; svg.style.display = "block"; }
  } catch (e) {
    container.textContent = url;
  }
}

function tallyChoice(options, responses) {
  const counts = options.map(() => 0);
  responses.forEach(v => { const i = options.indexOf(v); if (i >= 0) counts[i]++; });
  return counts;
}

function tallyClassify(items, categories, responses) {
  const out = {};
  items.forEach(it => { out[it.id] = categories.map(() => 0); });
  responses.forEach(val => {
    if (!val || typeof val !== "object") return;
    items.forEach(it => {
      const cat = val[it.id];
      const ci = categories.indexOf(cat);
      if (ci >= 0) out[it.id][ci]++;
    });
  });
  return out;
}

function renderChoiceBars(container, options, counts) {
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  container.innerHTML = options.map((label, i) => {
    const pct = Math.round((counts[i] / total) * 100);
    return `<div class="poll-bar-row">
      <p class="poll-bar-label">${label}</p>
      <div class="poll-bar-track"><div class="poll-bar-fill" style="width:${pct}%"></div></div>
      <p class="poll-bar-pct">${pct}%</p>
    </div>`;
  }).join("") + `<p class="poll-bar-total">${total === 1 && counts.every(c=>c===0) ? "aguardando respostas…" : total + " resposta(s)"}</p>`;
}

function renderClassifyRows(container, items, categories, tallies) {
  container.innerHTML = items.map(it => {
    const counts = tallies[it.id] || categories.map(() => 0);
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    const segs = categories.map((cat, i) => {
      const pct = Math.round((counts[i] / total) * 100);
      return `<div class="poll-seg poll-seg-${i}" style="width:${pct}%" title="${cat}: ${pct}%"></div>`;
    }).join("");
    // Percentual visível ao lado da barra — a cor some no segmento quando o voto
    // é baixo, e ninguém vai passar o mouse pra ler o title() durante a palestra.
    const pcts = categories.map((cat, i) => {
      const pct = Math.round((counts[i] / total) * 100);
      return `<span class="c${i}">${pct}%</span>`;
    }).join("");
    return `<div class="poll-classify-row">
      <p class="poll-classify-label">${it.label}</p>
      <div class="poll-classify-track">${segs}</div>
      <p class="poll-classify-pcts">${pcts}</p>
    </div>`;
  }).join("");
}

function showExample(mount, activity) {
  mount.classList.add("poll-example");
  const note = mount.querySelector(".poll-example-note");
  if (note) note.style.display = "block";
  const results = mount.querySelector(".poll-results");
  if (!results) return;
  if (activity.type === "classify") {
    const tallies = {};
    activity.items.forEach((it, idx) => { tallies[it.id] = activity.example[it.id]; });
    renderClassifyRows(results, activity.items, activity.categories, tallies);
  } else {
    renderChoiceBars(results, activity.options, activity.example);
  }
}

function mountActivity(db, sessionId, activity, mount) {
  const resultsEl = mount.querySelector(".poll-results");

  if (!db) { showExample(mount, activity); return; }

  const activityRef = doc(db, "sessions", sessionId, "activities", activity.id);
  const payload = activity.type === "classify"
    ? { question: activity.question, type: activity.type, status: "open", createdAt: serverTimestamp(),
        options: { categories: activity.categories, items: activity.items } }
    : { question: activity.question, type: activity.type, status: "open", createdAt: serverTimestamp(),
        options: activity.options };

  setDoc(activityRef, payload, { merge: true }).catch(() => showExample(mount, activity));

  const responsesCol = collection(activityRef, "responses");
  onSnapshot(responsesCol, snap => {
    const values = snap.docs.map(d => d.data().value);
    if (activity.type === "classify") {
      renderClassifyRows(resultsEl, activity.items, activity.categories, tallyClassify(activity.items, activity.categories, values));
    } else {
      renderChoiceBars(resultsEl, activity.options, tallyChoice(activity.options, values));
    }
  }, () => showExample(mount, activity));
}

function bootStaticQrCodes() {
  [].slice.call(document.querySelectorAll("[data-qr-static]")).forEach(el => {
    renderQR(el, el.getAttribute("data-qr-static"));
  });
}

function boot() {
  bootStaticQrCodes();
  const mounts = [].slice.call(document.querySelectorAll("[data-poll]"));
  if (!mounts.length) return;
  const sessionId = getSessionId();

  // O QR aponta para a página do participante sempre, mesmo se a conexão
  // com o Firestore falhar — só os RESULTADOS dependem da rede.
  mounts.forEach(m => renderQR(m.querySelector(".poll-qr"), joinUrl(sessionId, m.dataset.poll)));

  let app, auth, db;
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  } catch (e) {
    mounts.forEach(m => showExample(m, byId(m.dataset.poll)));
    return;
  }

  let settled = false;
  const fallbackTimer = setTimeout(() => {
    if (!settled) { settled = true; mounts.forEach(m => showExample(m, byId(m.dataset.poll))); }
  }, AUTH_TIMEOUT_MS);

  onAuthStateChanged(auth, user => {
    if (settled) return;
    if (user) {
      settled = true;
      clearTimeout(fallbackTimer);
      mounts.forEach(m => mountActivity(db, sessionId, byId(m.dataset.poll), m));
    }
  });

  signInAnonymously(auth).catch(() => {
    if (!settled) { settled = true; clearTimeout(fallbackTimer); mounts.forEach(m => showExample(m, byId(m.dataset.poll))); }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
