// Realtime dashboard frontend
// Fetches summary via SSE + REST APIs, renders Chart.js charts

const fmtMoney = (n) => '$' + (n ?? 0).toFixed(2);
const fmtPct  = (n) => (n ?? 0).toFixed(1) + '%';
const fmtTs   = (s) => s ? new Date(s).toLocaleTimeString() : '--:--';

// --- SSE stream ---
let es;
function startSSE() {
  es = new EventSource('/stream');
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    updateSummary(d);
    document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
  };
  es.onerror = () => {
    document.getElementById('conn-dot').className = 'dot red';
    document.getElementById('conn-text').textContent = 'OFFLINE';
    setTimeout(startSSE, 5000);
  };
}

// --- Summary cards ---
function updateSummary(d) {
  document.getElementById('capital').textContent = fmtMoney(d.capital);
  document.getElementById('exposure').textContent = `Exposure ${fmtMoney(d.exposure)}`;

  const pnlEl = document.getElementById('pnl');
  pnlEl.textContent = fmtMoney(d.total_pnl);
  pnlEl.style.color = d.total_pnl >= 0 ? 'var(--green)' : 'var(--red)';

  document.getElementById('win-rate').textContent = `Win Rate ${d.win_rate.toFixed(1)}%`;
  document.getElementById('open-count').textContent = d.open_positions;
  document.getElementById('closed-count').textContent = `Closed ${d.closed_trades}`;
  document.getElementById('last-cycle').textContent = fmtTs(d.last_cycle);

  document.getElementById('conn-dot').className = 'dot green';
  document.getElementById('conn-text').textContent = 'LIVE';
}

// --- Open positions table ---
async function loadOpen() {
  const res = await fetch('/api/open');
  const rows = await res.json();
  const tbody = document.querySelector('#tbl-open tbody');
  const empty = document.getElementById('open-empty');
  tbody.innerHTML = '';
  if (!rows.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  for (const r of rows) {
    const sideClass = r.side === 'BUY_YES' ? 'side-yes' : 'side-no';
    const sideLabel = r.side === 'BUY_YES' ? 'BUY YES' : 'BUY NO';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(r.market_question)}</td>
      <td class="${sideClass}">${sideLabel}</td>
      <td>${r.entry_price.toFixed(4)}</td>
      <td>${r.size.toFixed(2)}</td>
      <td>$${r.entry_value.toFixed(2)}</td>
      <td>${fmtTs(r.opened_at)}</td>
    `;
    tbody.appendChild(tr);
  }
}

// --- Recent trades table ---
async function loadTrades() {
  const res = await fetch('/api/trades?limit=30');
  const rows = await res.json();
  const tbody = document.querySelector('#tbl-trades tbody');
  tbody.innerHTML = '';
  for (const r of rows) {
    const pnlClass = (r.pnl ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg';
    const pnlSign = (r.pnl ?? 0) >= 0 ? '+' : '';
    const pnlPct = r.pnl_pct ? ` (${pnlSign}${(r.pnl_pct*100).toFixed(1)}%)` : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(r.market_question)}</td>
      <td>${r.side.replace('_',' ')}</td>
      <td>${r.entry_price.toFixed(4)}</td>
      <td class="${pnlClass}">${pnlSign}${(r.pnl ?? 0).toFixed(2)}${pnlPct}</td>
      <td>${esc(r.reason ?? '-')}</td>
      <td>${fmtTs(r.closed_at)}</td>
    `;
    tbody.appendChild(tr);
  }
}

// --- Charts ---
let chartCapital, chartPnl;

async function loadHistory() {
  const res = await fetch('/api/history?hours=24');
  const data = await res.json();

  // Capital/exposure line chart
  const labels = data.map(d => fmtTs(d.ts));
  const exposure = data.map(d => d.exposure);
  const capital = data.map(() => 100); // baseline

  const ctxC = document.getElementById('chart-capital').getContext('2d');
  if (chartCapital) chartCapital.destroy();
  chartCapital = new Chart(ctxC, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Capital', data: capital, borderColor: '#58a6ff', tension: 0.3, pointRadius: 0 },
        { label: 'Exposure', data: exposure, borderColor: '#d29922', tension: 0.3, pointRadius: 0, fill: true, backgroundColor: 'rgba(210,153,34,0.1)' }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#c9d1d9' } } },
      scales: {
        x: { ticks: { color: '#8b949e', maxTicksLimit: 8 }, grid: { color: '#30363d' } },
        y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }
      }
    }
  });
}

async function loadPnlChart() {
  const res = await fetch('/api/trades?limit=50');
  const rows = await res.json();
  const pnls = rows.map(r => r.pnl ?? 0);

  const ctxP = document.getElementById('chart-pnl').getContext('2d');
  if (chartPnl) chartPnl.destroy();
  chartPnl = new Chart(ctxP, {
    type: 'bar',
    data: {
      labels: pnls.map((_, i) => i + 1),
      datasets: [{
        label: 'PnL',
        data: pnls,
        backgroundColor: pnls.map(v => v >= 0 ? 'rgba(63,185,80,0.7)' : 'rgba(248,81,73,0.7)'),
        borderColor: pnls.map(v => v >= 0 ? '#3fb950' : '#f85149'),
        borderWidth: 1
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }
      }
    }
  });
}

// --- Utils ---
function esc(s) {
  const div = document.createElement('div');
  div.textContent = s ?? '';
  return div.innerHTML;
}

// --- Init ---
async function init() {
  startSSE();
  await loadOpen();
  await loadTrades();
  await loadHistory();
  await loadPnlChart();

  // Refresh tables every 30s
  setInterval(async () => {
    await loadOpen();
    await loadTrades();
    await loadPnlChart();
  }, 30000);
}

init();
