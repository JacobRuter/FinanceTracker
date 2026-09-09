const CATEGORIES = [
  'Auto', 'Bills & Utilities', 'Dining', 'Entertainment', 'Gas',
  'Groceries', 'Health & Fitness', 'Home', 'Insurance', 'Personal Care',
  'Shopping', 'Subscriptions', 'Transfer', 'Travel', 'Other', 'Uncategorized',
];

const state = {
  currentMonth: getCurrentMonth(),
  allTransactions: [],
  transactions: [],
  bills: [],
  categoryRules: [],
  dashboard: null,
  selectedIds: new Set(),
};

const sortState = {
  column: 'date',
  direction: 'desc',
};

const yearState = {
  currentYear: new Date().getFullYear(),
  data: null,
  allMerchants: [],      // merchant groups, as returned by /api/annual
  shown: [],             // groups currently rendered (after search filtering)
  selectedMerchants: new Set(),  // group keys
  expandedMerchants: new Set(),  // groups showing their original spellings
  suggestions: [],
  suggestionsOpen: false,
};

function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---- Init ----

document.addEventListener('DOMContentLoaded', async () => {
  updateThemeIcon(document.documentElement.getAttribute('data-theme'));
  await loadMonths();
  await Promise.all([loadDashboard(), loadTransactions(), loadBills(), loadDefaultSettings(), loadCategoryRules()]);
});

// ---- Theme ----

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const el = document.getElementById('theme-icon');
  if (el) el.textContent = theme === 'dark' ? '☀️' : '🌙';
}

// ---- Refresh ----

async function refreshTransactions(btn) {
  if (btn) btn.classList.add('refreshing');
  try {
    await loadMonths();
    await Promise.all([loadTransactions(), loadDashboard()]);
    toast('Transactions refreshed');
  } catch (e) {
    toast('Refresh failed: ' + e.message, true);
  } finally {
    if (btn) btn.classList.remove('refreshing');
  }
}

// ---- Tabs ----

function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  document.querySelector(`[data-tab="${name}"]`).classList.add('active');
  document.getElementById('month-bar').style.display = name === 'year' ? 'none' : 'flex';
  if (name === 'year') loadAnnualSummary();
}

// ---- Month navigation ----

async function loadMonths() {
  const data = await api('/months');
  const select = document.getElementById('month-select');
  const allMonths = [...new Set([...data.months, state.currentMonth])].sort().reverse();
  select.innerHTML = allMonths.map(m =>
    `<option value="${m}" ${m === state.currentMonth ? 'selected' : ''}>${formatMonth(m)}</option>`
  ).join('');
}

function ensureMonthOption(month) {
  const select = document.getElementById('month-select');
  if (![...select.options].some(o => o.value === month)) {
    const opt = document.createElement('option');
    opt.value = month;
    opt.textContent = formatMonth(month);
    const insertBefore = [...select.options].findIndex(o => o.value < month);
    insertBefore === -1 ? select.appendChild(opt) : select.insertBefore(opt, select.options[insertBefore]);
  }
  select.value = month;
}

async function onMonthChange(month) {
  state.currentMonth = month;
  await Promise.all([loadDashboard(), loadTransactions()]);
}

function prevMonth() {
  const [y, m] = state.currentMonth.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  ensureMonthOption(newMonth);
  onMonthChange(newMonth);
}

function nextMonth() {
  const [y, m] = state.currentMonth.split('-').map(Number);
  const d = new Date(y, m, 1);
  const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  ensureMonthOption(newMonth);
  onMonthChange(newMonth);
}

function formatMonth(m) {
  const [year, month] = m.split('-');
  return new Date(parseInt(year), parseInt(month) - 1, 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function formatMonthShort(m) {
  const [year, month] = m.split('-');
  return new Date(parseInt(year), parseInt(month) - 1, 1)
    .toLocaleDateString('en-US', { month: 'short' });
}

// ---- API helper ----

async function api(path, opts = {}) {
  const res = await fetch('api' + path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || res.statusText);
  }
  return res.json();
}

// ---- Dashboard ----

async function loadDashboard() {
  try {
    state.dashboard = await api(`/dashboard/${state.currentMonth}`);
    renderDashboard();
  } catch (e) {
    console.error('Dashboard:', e);
  }
}

function renderDashboard() {
  const d = state.dashboard;
  if (!d) return;

  document.getElementById('summary-cards').innerHTML = `
    <div class="card summary-card">
      <div class="card-label">Income</div>
      <div class="card-value">$${fmt(d.income)}</div>
      <button class="small-btn" onclick="editIncome()">Edit</button>
    </div>
    <div class="card summary-card">
      <div class="card-label">Spending</div>
      <div class="card-value">$${fmt(d.total_spending)}</div>
    </div>
    <div class="card summary-card">
      <div class="card-label">Bills</div>
      <div class="card-value">$${fmt(d.bills_total)}</div>
      <div class="card-sub">${d.bills_paid} of ${d.bills_count} paid</div>
    </div>
    <div class="card summary-card">
      <div class="card-label">Savings Goal</div>
      <div class="card-value savings-value">$${fmt(d.savings_target)}</div>
      <div class="card-sub ${d.saved_this_month >= 0 ? 'pos' : 'neg'}">
        ${d.saved_this_month >= 0
          ? `Saved $${fmt(d.saved_this_month)} this month`
          : `Over budget $${fmt(Math.abs(d.saved_this_month))}`}
      </div>
      <button class="small-btn" onclick="editSavings()">Edit</button>
    </div>
    <div class="card summary-card ${d.net_after_savings >= 0 ? 'positive' : 'negative'}">
      <div class="card-label">Left Over</div>
      <div class="card-value">${d.net_after_savings < 0 ? '-' : ''}$${fmt(Math.abs(d.net_after_savings))}</div>
      <div class="card-sub">After savings</div>
    </div>
  `;

  const billsEl = document.getElementById('bills-dashboard');
  if (!d.bill_payments || d.bill_payments.length === 0) {
    billsEl.innerHTML = '<p class="empty">No bills yet. Add them in Settings.</p>';
  } else {
    billsEl.innerHTML = d.bill_payments.map(p => `
      <div class="bill-row ${p.paid ? 'paid' : 'unpaid'}">
        <span class="bill-check" onclick="toggleBillPaid(${p.bill_id})">${p.paid ? '✓' : '○'}</span>
        <span class="bill-name">${esc(p.name)}</span>
        <span class="bill-amount">$${fmt(p.amount)}</span>
        ${p.due_day ? `<span class="bill-due">due ${p.due_day}${ordinal(p.due_day)}</span>` : ''}
      </div>
    `).join('');
  }

  renderWeeklyBreakdown(d.weeks, d.total_spendable);

  const chartEl = document.getElementById('category-chart');
  if (!d.categories || d.categories.length === 0) {
    chartEl.innerHTML = '<p class="empty">No transactions yet.</p>';
  } else {
    const max = Math.max(...d.categories.map(c => c.amount));
    chartEl.innerHTML = d.categories.map(c => `
      <div class="chart-row chart-row-clickable" data-category="${esc(c.category)}" onclick="showCategoryTransactions(this.dataset.category)">
        <div class="chart-label" title="${esc(c.category)}">${esc(c.category)}</div>
        <div class="chart-bar-wrap"><div class="chart-bar" style="width:${(c.amount / max * 100).toFixed(1)}%"></div></div>
        <div class="chart-amount">$${fmt(c.amount)}</div>
      </div>
    `).join('');
  }
}

function renderWeeklyBreakdown(weeks, totalSpendable) {
  const el = document.getElementById('weekly-breakdown');
  if (!weeks || weeks.length === 0) {
    el.innerHTML = '<p class="empty">Set income and savings goal to see weekly budget.</p>';
    return;
  }
  const currentWeek = weeks.find(w => w.status === 'current');
  let html = '';
  if (currentWeek) {
    const isOver = currentWeek.remaining < 0;
    html += `
      <div class="week-callout ${isOver ? 'over' : 'ok'}">
        <div class="callout-top">
          <span class="callout-label">This week (${currentWeek.label})</span>
          <span class="callout-amount">${isOver ? '-' : ''}$${fmt(Math.abs(currentWeek.remaining))}</span>
        </div>
        <div class="callout-sub">${isOver
          ? 'over budget — $' + fmt(currentWeek.budget) + ' was the target'
          : 'left to spend · $' + fmt(currentWeek.spent) + ' spent of $' + fmt(currentWeek.budget)}</div>
      </div>`;
  }
  html += weeks.map((w, i) => {
    const pct = w.budget > 0 ? Math.min(100, (w.spent / w.budget) * 100) : 0;
    const isOver = w.spent > w.budget;
    return `
      <div class="week-row ${w.status}">
        <div class="week-label">
          <span class="week-num">Wk ${i + 1}</span>
          <span class="week-dates">${w.label}</span>
        </div>
        <div class="week-bar-wrap"><div class="week-bar ${isOver ? 'over' : ''}" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="week-right">
          <span class="week-spent-amt ${isOver ? 'over-text' : ''}">$${fmt(w.spent)}</span>
          <span class="week-total"> / $${fmt(w.budget)}</span>
          ${w.status === 'current' ? `<span class="week-remaining-badge ${isOver ? 'over' : ''}">${isOver ? '-' : '+'}$${fmt(Math.abs(w.remaining))}</span>` : ''}
        </div>
      </div>`;
  }).join('');
  el.innerHTML = html;
}

async function editIncome() {
  document.getElementById('income-modal-month').textContent = formatMonth(state.currentMonth);
  document.getElementById('income-entry-amount').value = '';
  document.getElementById('income-entry-label').value = '';
  await renderIncomeEntries();
  document.getElementById('income-modal-overlay').classList.remove('hidden');
  document.getElementById('income-entry-amount').focus();
}

async function renderIncomeEntries() {
  const data = await api(`/income/${state.currentMonth}/entries`);
  const listEl = document.getElementById('income-entries-list');
  if (!data.entries.length) {
    listEl.innerHTML = '<p class="empty">No income yet. Add one below.</p>';
  } else {
    listEl.innerHTML = data.entries.map(e => `
      <div class="income-entry-row" data-id="${e.id}">
        <input class="income-entry-label-input" value="${esc(e.label)}" placeholder="Label" onchange="saveIncomeEntry(${e.id})">
        <input class="income-entry-amount-input" type="number" step="0.01" min="0" value="${e.amount}" onchange="saveIncomeEntry(${e.id})">
        <button class="income-entry-del" title="Remove" onclick="deleteIncomeEntry(${e.id})">×</button>
      </div>
    `).join('');
  }
  document.getElementById('income-modal-total').textContent = '$' + fmt(data.total);
}

async function saveIncomeEntry(id) {
  const row = document.querySelector(`.income-entry-row[data-id="${id}"]`);
  if (!row) return;
  const label = row.querySelector('.income-entry-label-input').value.trim();
  const amount = parseFloat(row.querySelector('.income-entry-amount-input').value);
  if (isNaN(amount) || amount < 0) { toast('Enter a valid amount', true); await renderIncomeEntries(); return; }
  await api(`/income/entries/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, label }) });
  await renderIncomeEntries();
}

async function saveIncomeTemplate() {
  const data = await api(`/income/${state.currentMonth}/save-template`, { method: 'POST' });
  toast(`Saved ${data.count} income source${data.count !== 1 ? 's' : ''} as the default for new months`);
}

async function addIncomeEntry() {
  const amountEl = document.getElementById('income-entry-amount');
  const labelEl = document.getElementById('income-entry-label');
  const amount = parseFloat(amountEl.value);
  if (isNaN(amount) || amount <= 0) { toast('Enter a valid income amount', true); return; }
  await api(`/income/${state.currentMonth}/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, label: labelEl.value.trim() }),
  });
  amountEl.value = '';
  labelEl.value = '';
  amountEl.focus();
  await renderIncomeEntries();
}

async function deleteIncomeEntry(id) {
  await api(`/income/entries/${id}`, { method: 'DELETE' });
  await renderIncomeEntries();
}

function closeIncomeModal() {
  document.getElementById('income-modal-overlay').classList.add('hidden');
  loadDashboard();
}

function editSavings() {
  document.getElementById('savings-modal-month').textContent = formatMonth(state.currentMonth);
  const input = document.getElementById('savings-modal-input');
  input.value = state.dashboard?.savings_target ?? '';
  document.getElementById('savings-modal-overlay').classList.remove('hidden');
  input.focus();
}

function closeSavingsModal() {
  document.getElementById('savings-modal-overlay').classList.add('hidden');
}

async function saveSavingsModal() {
  const amount = parseFloat(document.getElementById('savings-modal-input').value);
  if (isNaN(amount) || amount < 0) { toast('Enter a valid amount', true); return; }
  await api(`/savings/${state.currentMonth}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ savings_target: amount }) });
  closeSavingsModal();
  await loadDashboard();
}

// Custom confirm dialog — native confirm()/prompt() are blocked inside the HA ingress iframe.
function appConfirm(message, okLabel = 'Delete') {
  return new Promise(resolve => {
    const overlay = document.getElementById('confirm-modal-overlay');
    document.getElementById('confirm-modal-message').textContent = message;
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');
    okBtn.textContent = okLabel;
    const cleanup = () => {
      overlay.classList.add('hidden');
      okBtn.onclick = null;
      cancelBtn.onclick = null;
    };
    okBtn.onclick = () => { cleanup(); resolve(true); };
    cancelBtn.onclick = () => { cleanup(); resolve(false); };
    overlay.classList.remove('hidden');
  });
}

async function toggleBillPaid(billId) {
  await api(`/bill-payments/${state.currentMonth}/${billId}/toggle`, { method: 'POST' });
  await loadDashboard();
}

// ---- Transactions ----

async function loadTransactions() {
  try {
    const data = await api(`/transactions/${state.currentMonth}`);
    state.allTransactions = data.transactions;
    state.selectedIds.clear();
    filterTransactions();
    updateCategoryFilter();
    updateBulkDeleteButton();
    updateApplyMatchingButton();
  } catch (e) {
    console.error('Transactions:', e);
  }
}

function updateApplyMatchingButton() {
  const hasBillKeywords = state.bills.some(b => b.match_keyword);
  document.getElementById('apply-matching-btn').classList.toggle('hidden', !hasBillKeywords);
}

function filterTransactions() {
  const category = document.getElementById('category-filter').value;
  const hidePayments = document.getElementById('hide-payments').checked;
  state.transactions = state.allTransactions.filter(t => {
    if (hidePayments && t.type === 'payment') return false;
    if (category && t.category !== category) return false;
    return true;
  });
  renderTransactions();
}

function updateCategoryFilter() {
  const select = document.getElementById('category-filter');
  const current = select.value;
  const cats = [...new Set(state.allTransactions.filter(t => t.type === 'expense').map(t => t.category))].sort();
  select.innerHTML = '<option value="">All Categories</option>' +
    cats.map(c => `<option value="${esc(c)}" ${c === current ? 'selected' : ''}>${esc(c)}</option>`).join('');
}

// ---- Sorting ----

function sortBy(column) {
  if (sortState.column === column) {
    sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
  } else {
    sortState.column = column;
    // Dates and amounts default to descending; text columns default to ascending
    sortState.direction = (column === 'date' || column === 'amount') ? 'desc' : 'asc';
  }
  renderTransactions();
}

function sortTransactions(txs) {
  const { column, direction } = sortState;
  const mult = direction === 'asc' ? 1 : -1;
  return [...txs].sort((a, b) => {
    const va = column === 'amount' ? a[column] : String(a[column] ?? '').toLowerCase();
    const vb = column === 'amount' ? b[column] : String(b[column] ?? '').toLowerCase();
    if (va < vb) return -1 * mult;
    if (va > vb) return  1 * mult;
    return 0;
  });
}

function updateSortIndicators() {
  ['date', 'description', 'amount', 'category', 'source'].forEach(col => {
    const el = document.getElementById(`sort-${col}`);
    if (!el) return;
    el.textContent = sortState.column === col
      ? (sortState.direction === 'asc' ? '▲' : '▼')
      : '';
  });
}

const _txMap = {};

function renderTransactions() {
  const tbody = document.getElementById('transactions-body');
  const countEl = document.getElementById('tx-count');

  if (!state.transactions.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-row">No transactions. Upload a CSV to get started.</td></tr>`;
    countEl.textContent = '';
    document.getElementById('select-all').checked = false;
    return;
  }

  state.transactions.forEach(t => { _txMap[t.id] = t; });
  const expenses = state.transactions.filter(t => t.type === 'expense');
  countEl.textContent = `${expenses.length} expense${expenses.length !== 1 ? 's' : ''}`;

  updateSortIndicators();
  const sorted = sortTransactions(state.transactions);

  tbody.innerHTML = sorted.map(t => {
    const checked = state.selectedIds.has(t.id);
    const excluded = t.exclude_from_spending;
    const rowClass = [
      t.type === 'payment' ? 'payment-row' : '',
      excluded ? 'bill-excluded-row' : '',
      checked ? 'selected-row' : '',
    ].filter(Boolean).join(' ');
    return `
    <tr class="${rowClass}">
      <td><input type="checkbox" class="row-check" onchange="toggleRowSelect(${t.id}, this.checked)" ${checked ? 'checked' : ''}></td>
      <td style="white-space:nowrap">${t.date}</td>
      <td class="desc-cell" title="${esc(t.description)}">${esc(t.description)}</td>
      <td class="amount-cell ${(t.type === 'payment' || t.amount < 0) ? 'credit' : ''}">${(t.type === 'payment' || t.amount < 0) ? '+' : ''}$${fmt(Math.abs(t.amount))}</td>
      <td>
        <select class="inline-select" onchange="updateCategory(${t.id}, this.value)">
          ${categoryOptions(t.category)}
        </select>
      </td>
      <td>
        <span class="source-badge ${t.source}">${t.source.replace('_', ' ')}</span>
        ${excluded ? '<span class="bill-badge" title="Excluded from spending — counted in Bills">Bill</span>' : ''}
      </td>
      <td><input class="notes-input" type="text" value="${esc(t.notes || '')}" onblur="updateNotes(${t.id}, this.value)" placeholder="Add note…"></td>
      <td class="action-cell">
        <button class="icon-btn edit" onclick="openEditModal(${t.id})" title="Edit">✎</button>
        <button class="icon-btn delete" onclick="deleteTransaction(${t.id})" title="Delete">×</button>
      </td>
    </tr>`;
  }).join('');
}

// ---- Bulk selection ----

function toggleRowSelect(id, checked) {
  if (checked) state.selectedIds.add(id);
  else state.selectedIds.delete(id);
  updateBulkDeleteButton();
  // Update select-all checkbox state
  const allVisible = state.transactions.map(t => t.id);
  const allChecked = allVisible.every(id => state.selectedIds.has(id));
  document.getElementById('select-all').checked = allChecked && allVisible.length > 0;
  // Highlight row
  const row = document.querySelector(`input[onchange="toggleRowSelect(${id}, this.checked)"]`)?.closest('tr');
  if (row) row.classList.toggle('selected-row', checked);
}

function toggleSelectAll(checked) {
  state.transactions.forEach(t => {
    if (checked) state.selectedIds.add(t.id);
    else state.selectedIds.delete(t.id);
  });
  updateBulkDeleteButton();
  renderTransactions();
}

function updateBulkDeleteButton() {
  const btn = document.getElementById('bulk-delete-btn');
  const count = state.selectedIds.size;
  btn.classList.toggle('hidden', count === 0);
  document.getElementById('bulk-count').textContent = count;
}

async function deleteSelected() {
  const ids = [...state.selectedIds];
  if (!ids.length) return;
  if (!(await appConfirm(`Delete ${ids.length} transaction${ids.length !== 1 ? 's' : ''}?`))) return;
  await api('/transactions/bulk', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  state.allTransactions = state.allTransactions.filter(t => !state.selectedIds.has(t.id));
  state.selectedIds.clear();
  filterTransactions();
  updateCategoryFilter();
  updateBulkDeleteButton();
  await loadDashboard();
  toast(`Deleted ${ids.length} transaction${ids.length !== 1 ? 's' : ''}`);
}

function categoryOptions(current) {
  const cats = CATEGORIES.includes(current) ? CATEGORIES : [current, ...CATEGORIES];
  return cats.map(c => `<option value="${esc(c)}" ${c === current ? 'selected' : ''}>${esc(c)}</option>`).join('');
}

async function updateCategory(id, category) {
  await api(`/transactions/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category }) });
  const tx = state.allTransactions.find(t => t.id === id);
  if (tx) tx.category = category;
  updateCategoryFilter();
  if (document.getElementById('tab-dashboard').classList.contains('active')) await loadDashboard();
}

async function updateNotes(id, notes) {
  await api(`/transactions/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes }) });
  const tx = state.allTransactions.find(t => t.id === id);
  if (tx) tx.notes = notes;
}

async function deleteTransaction(id) {
  if (!(await appConfirm('Delete this transaction?'))) return;
  await api(`/transactions/${id}`, { method: 'DELETE' });
  state.allTransactions = state.allTransactions.filter(t => t.id !== id);
  state.selectedIds.delete(id);
  filterTransactions();
  updateCategoryFilter();
  updateBulkDeleteButton();
  if (document.getElementById('tab-dashboard').classList.contains('active')) await loadDashboard();
}

async function handleCSVUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  const replace = document.getElementById('replace-upload').checked;
  try {
    const res = await fetch(`api/transactions/upload?replace=${replace}`, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Upload failed');
    const notes = [
      replace ? 'replaced existing' : '',
    ].filter(Boolean).join(', ');
    toast(`Imported ${data.imported} transactions for ${formatMonth(data.month_year)}${notes ? ' (' + notes + ')' : ''}`);
    state.currentMonth = data.month_year;
    await loadMonths();
    ensureMonthOption(data.month_year);
    await Promise.all([loadDashboard(), loadTransactions()]);
  } catch (e) {
    toast(e.message, true);
  }
  input.value = '';
}


// ---- Bills ----

async function loadBills() {
  const data = await api('/bills');
  state.bills = data.bills;
  renderBillsSettings();
  updateApplyMatchingButton();
}

function renderBillsSettings() {
  const el = document.getElementById('bills-list');
  if (!state.bills.length) { el.innerHTML = '<p class="empty">No bills yet.</p>'; return; }
  el.innerHTML = state.bills.map(b => `
    <div class="bill-item">
      <span class="bill-name">${esc(b.name)}</span>
      <span class="bill-amount">$${fmt(b.amount)}</span>
      ${b.due_day ? `<span class="bill-due">due ${b.due_day}${ordinal(b.due_day)}</span>` : ''}
      ${b.match_keyword ? `<span class="keyword-badge" title="Transactions matching this keyword are excluded from spending">${esc(b.match_keyword)}</span>` : ''}
      <button class="icon-btn edit" onclick="openEditBillModal(${b.id})" title="Edit">✎</button>
      <button class="icon-btn delete" onclick="deleteBill(${b.id})">×</button>
    </div>
  `).join('');
}

function openEditBillModal(id) {
  const bill = state.bills.find(b => b.id === id);
  if (!bill) return;

  document.querySelector('#modal-overlay .modal h3').textContent = 'Edit Bill';
  document.getElementById('modal-body').innerHTML = `
    <div class="edit-form">
      <div class="edit-row">
        <label class="settings-label">Name</label>
        <input type="text" id="edit-bill-name" value="${esc(bill.name)}">
      </div>
      <div class="edit-row-two">
        <div>
          <label class="settings-label">Amount ($)</label>
          <input type="number" id="edit-bill-amount" value="${bill.amount}" step="0.01" min="0">
        </div>
        <div>
          <label class="settings-label">Due Day</label>
          <input type="number" id="edit-bill-due" value="${bill.due_day || ''}" min="1" max="31" placeholder="Optional">
        </div>
      </div>
      <div class="edit-row">
        <label class="settings-label">Match Keywords</label>
        <input type="text" id="edit-bill-keyword" value="${esc(bill.match_keyword || '')}"
          placeholder="Comma-separated keywords — excludes matching transactions from spending">
      </div>
    </div>
  `;
  document.querySelector('#modal-overlay .modal-footer').innerHTML = `
    <button onclick="closeModal()">Cancel</button>
    <button class="btn-primary" onclick="saveEditBill(${id})">Save</button>
  `;
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('edit-bill-name').focus();
}

async function saveEditBill(id) {
  const name = document.getElementById('edit-bill-name').value.trim();
  const amount = parseFloat(document.getElementById('edit-bill-amount').value);
  const dueDayRaw = document.getElementById('edit-bill-due').value;
  const keyword = document.getElementById('edit-bill-keyword').value.trim();

  if (!name || isNaN(amount) || amount < 0) {
    toast('Please enter a valid name and amount', true);
    return;
  }

  await api(`/bills/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      amount,
      due_day: dueDayRaw ? parseInt(dueDayRaw) : null,
      match_keyword: keyword || null,
    }),
  });

  closeModal();
  await loadBills();
  await applyBillMatching(true);
  await loadDashboard();
  toast(`Bill "${name}" updated`);
}

async function addBill(e) {
  e.preventDefault();
  const form = e.target;
  const body = {
    name: form.name.value.trim(),
    amount: parseFloat(form.amount.value),
    due_day: form.due_day.value ? parseInt(form.due_day.value) : null,
    match_keyword: form.match_keyword.value.trim() || null,
  };
  await api('/bills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  form.reset();
  await loadBills();
  // If a keyword was set, re-apply matching for current month
  if (body.match_keyword) {
    await applyBillMatching(true);
  }
  await loadDashboard();
  toast(`Bill "${body.name}" added${body.match_keyword ? ` · matching "${body.match_keyword}"` : ''}`);
}

async function applyBillMatching(silent = false) {
  const data = await api(`/transactions/${state.currentMonth}/apply-bill-matching`, { method: 'POST' });
  await Promise.all([loadTransactions(), loadDashboard()]);
  if (!silent) toast(`Bill matching applied · ${data.count} transaction${data.count !== 1 ? 's' : ''} excluded`);
}

async function deleteBill(id) {
  if (!(await appConfirm('Delete this bill?'))) return;
  await api(`/bills/${id}`, { method: 'DELETE' });
  await loadBills();
  await loadDashboard();
}

// ---- Category Rules ----

async function loadCategoryRules() {
  const data = await api('/category-rules');
  state.categoryRules = data.rules;
  renderCategoryRules();
  const sel = document.getElementById('rule-category-select');
  if (sel && !sel.options.length) {
    sel.innerHTML = '<option value="">— Category —</option>' +
      CATEGORIES.map(c => `<option value="${c}">${esc(c)}</option>`).join('');
  }
}

function renderCategoryRules() {
  const el = document.getElementById('category-rules-list');
  if (!state.categoryRules || !state.categoryRules.length) {
    el.innerHTML = '<p class="empty">No rules yet.</p>';
    return;
  }
  el.innerHTML = state.categoryRules.map(r => `
    <div class="bill-item">
      <span class="bill-name">${esc(r.keyword)}</span>
      <span class="bill-amount">${esc(r.category)}</span>
      <button class="icon-btn delete" onclick="deleteCategoryRule(${r.id})">×</button>
    </div>
  `).join('');
}

async function addCategoryRule(e) {
  e.preventDefault();
  const form = e.target;
  const keyword = form.keyword.value.trim();
  const category = form.category.value;
  if (!keyword || !category) return;
  await api('/category-rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword, category }),
  });
  form.reset();
  await loadCategoryRules();
  toast(`Rule added: "${keyword}" → ${category}`);
}

async function deleteCategoryRule(id) {
  if (!(await appConfirm('Delete this rule?'))) return;
  await api(`/category-rules/${id}`, { method: 'DELETE' });
  await loadCategoryRules();
}

// ---- Settings ----

async function loadDefaultSettings() {
  const [incomeData, savingsData] = await Promise.all([
    api('/settings/default_income'),
    api('/settings/default_savings'),
  ]);
  if (incomeData.value !== null) document.getElementById('default-income').value = incomeData.value;
  if (savingsData.value !== null) document.getElementById('default-savings').value = savingsData.value;
}

async function saveDefaultIncome() {
  const val = parseFloat(document.getElementById('default-income').value);
  if (isNaN(val) || val < 0) { toast('Enter a valid income amount', true); return; }
  await api('/settings/default_income', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: val }) });
  toast('Default income saved');
  await loadDashboard();
}

async function saveDefaultSavings() {
  const val = parseFloat(document.getElementById('default-savings').value);
  if (isNaN(val) || val < 0) { toast('Enter a valid savings amount', true); return; }
  await api('/settings/default_savings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: val }) });
  toast('Default savings goal saved');
  await loadDashboard();
}

// ---- Year tab ----

async function loadAnnualSummary() {
  try {
    document.getElementById('year-display').textContent = yearState.currentYear;
    yearState.data = await api(`/annual/${yearState.currentYear}`);
    yearState.allMerchants = yearState.data.merchants || [];
    yearState.suggestions = yearState.data.merchant_suggestions || [];
    yearState.selectedMerchants.clear();
    renderAnnualSummary();
  } catch (e) {
    console.error('Annual:', e);
  }
}

function prevYear() {
  yearState.currentYear--;
  loadAnnualSummary();
}

function nextYear() {
  yearState.currentYear++;
  loadAnnualSummary();
}

function renderAnnualSummary() {
  const d = yearState.data;
  if (!d) return;

  document.getElementById('year-summary-cards').innerHTML = `
    <div class="card summary-card">
      <div class="card-label">Total Income</div>
      <div class="card-value">$${fmt(d.total_income)}</div>
    </div>
    <div class="card summary-card">
      <div class="card-label">Total Spending</div>
      <div class="card-value">$${fmt(d.total_spending)}</div>
    </div>
    <div class="card summary-card">
      <div class="card-label">Total Bills</div>
      <div class="card-value">$${fmt(d.total_bills)}</div>
    </div>
    <div class="card summary-card">
      <div class="card-label">Total Goal</div>
      <div class="card-value savings-value">$${fmt(d.total_savings)}</div>
    </div>
    <div class="card summary-card ${d.total_net >= 0 ? 'positive' : 'negative'}">
      <div class="card-label">Net Saved</div>
      <div class="card-value">${d.total_net < 0 ? '-' : ''}$${fmt(Math.abs(d.total_net))}</div>
    </div>
  `;

  // Monthly table
  const tbody = document.getElementById('year-monthly-body');
  tbody.innerHTML = d.months.map(m => {
    if (!m.has_data) {
      return `<tr class="no-data-row">
        <td><button class="month-link" onclick="goToMonth('${m.month_year}')">${formatMonthShort(m.month_year)}</button></td>
        <td colspan="5" class="no-data-cell">No data</td>
      </tr>`;
    }
    return `<tr>
      <td><button class="month-link" onclick="goToMonth('${m.month_year}')">${formatMonthShort(m.month_year)}</button></td>
      <td>$${fmt(m.income)}</td>
      <td>$${fmt(m.spending)}</td>
      <td>$${fmt(m.bills)}</td>
      <td>$${fmt(m.savings)}</td>
      <td class="${m.net >= 0 ? 'net-positive' : 'net-negative'}">
        ${m.net < 0 ? '-' : ''}$${fmt(Math.abs(m.net))}
      </td>
    </tr>`;
  }).join('');

  filterMerchants();
}

function goToMonth(month) {
  state.currentMonth = month;
  ensureMonthOption(month);
  document.getElementById('month-select').value = month;
  showTab('dashboard');
  Promise.all([loadDashboard(), loadTransactions()]);
}

// ---- Merchants ----
// Merchants arrive pre-grouped from the API: "Kroger", "KROGER #445" and
// "kroger" are one row. A group can hold several original spellings
// ("variants"), which the row expands to show.

function visibleMerchants() {
  const q = document.getElementById('merchant-search').value.trim().toLowerCase();
  if (!q) return yearState.allMerchants;
  return yearState.allMerchants.filter(m =>
    m.description.toLowerCase().includes(q) ||
    m.variants.some(v => v.description.toLowerCase().includes(q))
  );
}

function filterMerchants() {
  yearState.shown = visibleMerchants();
  renderSuggestions();
  renderMerchants(yearState.shown);
}

function renderMerchants(merchants) {
  const el = document.getElementById('merchant-list');
  if (!merchants || merchants.length === 0) {
    el.innerHTML = '<p class="empty">No merchants found.</p>';
    updateRenameBar();
    return;
  }

  el.innerHTML = merchants.map((m, i) => {
    const selected = yearState.selectedMerchants.has(m.key);
    const expanded = yearState.expandedMerchants.has(m.key);
    const variants = m.variant_count > 1
      ? `<button class="merchant-variants-btn" onclick="toggleMerchantVariants(${i})"
           title="Show the original descriptions">${m.variant_count} spellings ${expanded ? '▾' : '▸'}</button>`
      : '';
    const merged = m.merged
      ? `<button class="merchant-merged-tag" onclick="unmergeMerchant(${i})"
           title="Undo this merge">merged ✕</button>`
      : '';
    const variantList = expanded
      ? `<div class="merchant-variant-list">${m.variants.map(v => `
          <div class="merchant-variant">
            <span class="merchant-variant-name">${esc(v.description)}</span>
            <span class="merchant-count">${v.count}×</span>
            <span class="merchant-total">$${fmt(v.total)}</span>
          </div>`).join('')}</div>`
      : '';

    return `
      <div class="merchant-group ${selected ? 'selected' : ''}">
        <div class="merchant-row">
          <input type="checkbox" class="merchant-check" onchange="toggleMerchant(${i}, this.checked)" ${selected ? 'checked' : ''}>
          <button class="merchant-name-btn" onclick="showMerchantTransactions(${i})" title="View transactions">${esc(m.description)}</button>
          ${variants}${merged}
          <span class="merchant-count">${m.count}×</span>
          <span class="merchant-total">$${fmt(m.total)}</span>
        </div>
        ${variantList}
      </div>`;
  }).join('');

  updateRenameBar();
}

function toggleMerchantVariants(index) {
  const m = yearState.shown[index];
  if (!m) return;
  if (yearState.expandedMerchants.has(m.key)) yearState.expandedMerchants.delete(m.key);
  else yearState.expandedMerchants.add(m.key);
  renderMerchants(yearState.shown);
}

function toggleMerchant(index, checked) {
  const m = yearState.shown[index];
  if (!m) return;
  if (checked) yearState.selectedMerchants.add(m.key);
  else yearState.selectedMerchants.delete(m.key);
  renderMerchants(yearState.shown);
}

function updateRenameBar() {
  const bar = document.getElementById('rename-bar');
  const keys = [...yearState.selectedMerchants];
  bar.classList.toggle('hidden', keys.length === 0);
  document.getElementById('selected-merchant-count').textContent =
    `${keys.length} merchant${keys.length !== 1 ? 's' : ''} selected`;

  const btn = document.getElementById('merge-btn');
  if (btn) btn.textContent = keys.length > 1 ? 'Merge' : 'Rename';

  // Prefill with the busiest selected name, which is usually the one to keep.
  const input = document.getElementById('rename-input');
  if (input && !input.dataset.touched) {
    const picked = yearState.allMerchants
      .filter(m => yearState.selectedMerchants.has(m.key))
      .sort((a, b) => b.count - a.count)[0];
    input.value = picked ? picked.description : '';
  }
}

function clearMerchantSelection() {
  yearState.selectedMerchants.clear();
  const input = document.getElementById('rename-input');
  input.value = '';
  delete input.dataset.touched;
  filterMerchants();
}

async function applyRename() {
  const input = document.getElementById('rename-input');
  const toName = input.value.trim();
  if (!toName) { toast('Enter a name', true); return; }
  const keys = [...yearState.selectedMerchants];
  if (keys.length === 0) return;

  await api('/merchants/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys, name: toName }),
  });

  toast(keys.length > 1
    ? `Merged ${keys.length} merchants into "${toName}"`
    : `Renamed to "${toName}"`);
  yearState.selectedMerchants.clear();
  input.value = '';
  delete input.dataset.touched;
  await loadAnnualSummary();
}

async function unmergeMerchant(index) {
  const m = yearState.shown[index];
  if (!m) return;
  await api('/merchants/unmerge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: m.key }),
  });
  toast(`Unmerged "${m.description}"`);
  await loadAnnualSummary();
}

// ---- Suggested merges ----
// Matches the automatic pass will not make on its own (a trailing city, a
// squashed-together spelling), offered for one-click confirmation.

function renderSuggestions() {
  const el = document.getElementById('merchant-suggestions');
  if (!el) return;
  const list = yearState.suggestions || [];
  if (list.length === 0) { el.innerHTML = ''; return; }

  const open = yearState.suggestionsOpen;
  el.innerHTML = `
    <button class="suggestions-toggle" onclick="toggleSuggestions()">
      ${open ? '▾' : '▸'} ${list.length} possible duplicate${list.length !== 1 ? 's' : ''} to review
    </button>
    ${open ? `<div class="suggestion-list">${list.map((s, i) => `
      <div class="suggestion-row">
        <div class="suggestion-names">
          <strong>${esc(s.names[0])}</strong> <span class="suggestion-plus">+</span> <strong>${esc(s.names[1])}</strong>
          <div class="suggestion-reason">${esc(s.reason)} · $${fmt(s.totals[0] + s.totals[1])} combined</div>
        </div>
        <button class="btn-primary btn-sm" onclick="acceptSuggestion(${i})">Merge as "${esc(s.suggested_name)}"</button>
        <button class="btn-ghost btn-sm" onclick="dismissSuggestion(${i})">Not the same</button>
      </div>`).join('')}</div>` : ''}
  `;
}

function toggleSuggestions() {
  yearState.suggestionsOpen = !yearState.suggestionsOpen;
  renderSuggestions();
}

async function acceptSuggestion(index) {
  const s = yearState.suggestions[index];
  if (!s) return;
  await api('/merchants/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: s.keys, name: s.suggested_name }),
  });
  toast(`Merged into "${s.suggested_name}"`);
  await loadAnnualSummary();
}

async function dismissSuggestion(index) {
  const s = yearState.suggestions[index];
  if (!s) return;
  await api('/merchants/dismiss-suggestion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: s.keys }),
  });
  await loadAnnualSummary();
}

// ---- Merchant transactions modal ----

async function showMerchantTransactions(index) {
  const m = yearState.shown[index];
  if (!m) return;
  const name = m.description;
  const data = await api(`/merchants/transactions?key=${encodeURIComponent(m.key)}&year=${yearState.currentYear}`);
  const txs = data.transactions;
  const total = txs.reduce((s, t) => s + t.amount, 0);

  const modal = document.querySelector('#modal-overlay .modal');
  modal.classList.add('modal-wide');
  document.querySelector('#modal-overlay .modal h3').textContent = esc(name);

  document.getElementById('modal-body').innerHTML = txs.length === 0
    ? '<p class="empty">No transactions found.</p>'
    : `
      <div class="merchant-tx-summary">${txs.length} transaction${txs.length !== 1 ? 's' : ''} · Total: <strong>$${fmt(total)}</strong></div>
      <div class="merchant-tx-scroll">
        <table class="merchant-tx-table">
          <thead>
            <tr><th>Date</th><th>Month</th><th>Description</th><th>Amount</th><th>Category</th><th>Notes</th></tr>
          </thead>
          <tbody>
            ${txs.map(t => `
              <tr>
                <td style="white-space:nowrap">${t.date}</td>
                <td>${formatMonthShort(t.month_year)}</td>
                <td style="color:var(--text-muted)">${esc(t.description)}</td>
                <td class="amount-cell">$${fmt(t.amount)}</td>
                <td>${esc(t.category)}</td>
                <td style="color:var(--text-muted)">${esc(t.notes || '')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

  document.querySelector('#modal-overlay .modal-footer').innerHTML =
    `<button onclick="closeModal()">Close</button>`;

  document.getElementById('modal-overlay').classList.remove('hidden');
}

// ---- Category transactions modal ----

function showCategoryTransactions(category) {
  const txs = state.allTransactions.filter(t => t.category === category && t.type === 'expense');
  const total = txs.reduce((s, t) => s + t.amount, 0);

  const modal = document.querySelector('#modal-overlay .modal');
  modal.classList.add('modal-wide');
  document.querySelector('#modal-overlay .modal h3').textContent = category;

  document.getElementById('modal-body').innerHTML = txs.length === 0
    ? '<p class="empty">No transactions in this category.</p>'
    : `
      <div class="merchant-tx-summary">${txs.length} transaction${txs.length !== 1 ? 's' : ''} · Total: <strong>$${fmt(total)}</strong></div>
      <div class="merchant-tx-scroll">
        <table class="merchant-tx-table">
          <thead>
            <tr><th>Date</th><th>Description</th><th>Amount</th><th>Notes</th></tr>
          </thead>
          <tbody>
            ${txs.sort((a, b) => b.date.localeCompare(a.date)).map(t => `
              <tr>
                <td style="white-space:nowrap">${t.date}</td>
                <td>${esc(t.description)}</td>
                <td class="amount-cell">$${fmt(t.amount)}</td>
                <td style="color:var(--text-muted)">${esc(t.notes || '')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

  document.querySelector('#modal-overlay .modal-footer').innerHTML =
    `<button onclick="closeModal()">Close</button>`;

  document.getElementById('modal-overlay').classList.remove('hidden');
}

// ---- Edit Modal ----

let _editingTxId = null;

function openAddModal() {
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('add-date').value = today;
  document.getElementById('add-description').value = '';
  document.getElementById('add-amount').value = '';
  document.getElementById('add-type').value = 'expense';
  document.getElementById('add-source').value = 'manual';
  document.getElementById('add-notes').value = '';
  document.getElementById('add-category').innerHTML = categoryOptions('Uncategorized');
  document.getElementById('add-modal-overlay').classList.remove('hidden');
  document.getElementById('add-description').focus();
}

function closeAddModal() {
  document.getElementById('add-modal-overlay').classList.add('hidden');
}

async function submitAddTransaction() {
  const date = document.getElementById('add-date').value;
  const description = document.getElementById('add-description').value.trim();
  const amount = parseFloat(document.getElementById('add-amount').value);
  const type = document.getElementById('add-type').value;
  const category = document.getElementById('add-category').value;
  const source = document.getElementById('add-source').value;
  const notes = document.getElementById('add-notes').value.trim();

  if (!date || !description || isNaN(amount) || amount < 0) {
    toast('Please fill in date, description, and a valid amount', true);
    return;
  }
  try {
    await api('/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, description, amount, type, category, source, notes }),
    });
    closeAddModal();
    const newMonth = date.slice(0, 7);
    if (newMonth === state.currentMonth) await loadTransactions();
    else ensureMonthOption(newMonth);
    await loadDashboard();
    toast('Transaction added');
  } catch (e) {
    toast(e.message, true);
  }
}

function openEditModal(id) {
  const tx = _txMap[id];
  if (!tx) return;
  _editingTxId = id;

  document.getElementById('modal-body').innerHTML = `
    <div class="edit-form">
      <div class="edit-row-two">
        <div>
          <label class="settings-label">Date</label>
          <input type="date" id="edit-date" value="${tx.date}">
        </div>
        <div>
          <label class="settings-label">Type</label>
          <select id="edit-type" class="edit-select">
            <option value="expense" ${tx.type === 'expense' ? 'selected' : ''}>Expense</option>
            <option value="payment" ${tx.type === 'payment' ? 'selected' : ''}>Payment / Credit</option>
          </select>
        </div>
      </div>
      <div class="edit-row">
        <label class="settings-label">Description</label>
        <input type="text" id="edit-description" value="${esc(tx.description)}">
      </div>
      <div class="edit-row-two">
        <div>
          <label class="settings-label">Amount ($)</label>
          <input type="number" id="edit-amount" value="${tx.amount}" step="0.01" min="0">
        </div>
        <div>
          <label class="settings-label">Category</label>
          <select id="edit-category" class="edit-select">${categoryOptions(tx.category)}</select>
        </div>
      </div>
      <div class="edit-row-two">
        <div>
          <label class="settings-label">Source</label>
          <select id="edit-source" class="edit-select">
            <option value="chase" ${tx.source === 'chase' ? 'selected' : ''}>Chase</option>
            <option value="capital_one" ${tx.source === 'capital_one' ? 'selected' : ''}>Capital One</option>
            <option value="manual" ${tx.source === 'manual' ? 'selected' : ''}>Manual</option>
          </select>
        </div>
        <div>
          <label class="settings-label">Notes</label>
          <input type="text" id="edit-notes" value="${esc(tx.notes || '')}" placeholder="Optional note">
        </div>
      </div>
      <div class="edit-row">
        <label class="toggle-label exclude-toggle">
          <input type="checkbox" id="edit-exclude" ${tx.exclude_from_spending ? 'checked' : ''}>
          Exclude from spending <span class="exclude-hint">(already counted in Bills — won't be added to your spending total)</span>
        </label>
      </div>
    </div>
  `;

  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('edit-date').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.querySelector('#modal-overlay .modal').classList.remove('modal-wide');
  document.querySelector('#modal-overlay .modal h3').textContent = 'Edit Transaction';
  document.querySelector('#modal-overlay .modal-footer').innerHTML =
    `<button onclick="closeModal()">Cancel</button>
     <button class="btn-primary" onclick="saveModal()">Save</button>`;
  _editingTxId = null;
}

async function saveModal() {
  if (_editingTxId === null) { closeModal(); return; }
  const fields = {
    date: document.getElementById('edit-date').value,
    description: document.getElementById('edit-description').value.trim(),
    amount: parseFloat(document.getElementById('edit-amount').value),
    type: document.getElementById('edit-type').value,
    category: document.getElementById('edit-category').value,
    source: document.getElementById('edit-source').value,
    notes: document.getElementById('edit-notes').value.trim(),
    exclude_from_spending: document.getElementById('edit-exclude').checked ? 1 : 0,
  };
  if (!fields.date || !fields.description || isNaN(fields.amount) || fields.amount < 0) {
    toast('Please fill in date, description, and a valid amount', true);
    return;
  }
  try {
    if (_editingTxId === 'new') {
      const res = await api('/transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
      const newMonth = fields.date.slice(0, 7);
      if (newMonth === state.currentMonth) {
        await loadTransactions();
      } else {
        ensureMonthOption(newMonth);
      }
      await loadDashboard();
      toast('Transaction added');
    } else {
      await api(`/transactions/${_editingTxId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
      const newMonth = fields.date.slice(0, 7);
      if (newMonth !== state.currentMonth) {
        state.allTransactions = state.allTransactions.filter(t => t.id !== _editingTxId);
      } else {
        const tx = state.allTransactions.find(t => t.id === _editingTxId);
        if (tx) Object.assign(tx, fields);
      }
      filterTransactions();
      updateCategoryFilter();
        await loadDashboard();
      toast('Transaction updated');
    }
    closeModal();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---- Paste Modal ----

const pasteState = { transactions: [] };

function openPasteModal() {
  document.getElementById('paste-textarea').value = '';
  document.getElementById('paste-source').value = 'chase';
  document.getElementById('paste-preview').classList.add('hidden');
  document.getElementById('paste-import-btn').classList.add('hidden');
  pasteState.transactions = [];
  document.getElementById('paste-modal-overlay').classList.remove('hidden');
  document.getElementById('paste-textarea').focus();
}

function closePasteModal() {
  document.getElementById('paste-modal-overlay').classList.add('hidden');
}

function parsePaste() {
  const text = document.getElementById('paste-textarea').value;
  const source = document.getElementById('paste-source').value;

  const parsed = source === 'chase' ? parseChasePaste(text) : parseCapOnePaste(text);

  if (parsed.length === 0) {
    toast('No transactions found — make sure you copied the full transaction list from your bank.', true);
    return;
  }

  pasteState.transactions = parsed;
  renderPastePreview();
  document.getElementById('paste-preview').classList.remove('hidden');
  updatePasteImportBtn();
}

function renderPastePreview() {
  const txs = pasteState.transactions;
  document.getElementById('paste-parse-count').textContent =
    `${txs.length} transaction${txs.length !== 1 ? 's' : ''} found`;

  document.getElementById('paste-preview-body').innerHTML = txs.map((t, i) => `
    <tr>
      <td style="white-space:nowrap">${t.date}</td>
      <td class="desc-cell" title="${esc(t.description)}">${esc(t.description)}</td>
      <td class="amount-cell ${(t.type === 'payment' || t.amount < 0) ? 'credit' : ''}">${(t.type === 'payment' || t.amount < 0) ? '+' : ''}$${fmt(Math.abs(t.amount))}</td>
      <td style="color:var(--text-muted);font-size:12px">${esc([t.notes, t.type === 'payment' ? 'Card payment' : (t.amount < 0 ? 'Refund' : '')].filter(Boolean).join(' · '))}</td>
      <td><button class="icon-btn delete" onclick="removePasteRow(${i})" title="Remove">×</button></td>
    </tr>`).join('');
}

function removePasteRow(idx) {
  pasteState.transactions.splice(idx, 1);
  if (pasteState.transactions.length === 0) {
    document.getElementById('paste-preview').classList.add('hidden');
  } else {
    renderPastePreview();
  }
  updatePasteImportBtn();
}

function updatePasteImportBtn() {
  const btn = document.getElementById('paste-import-btn');
  const count = pasteState.transactions.length;
  btn.classList.toggle('hidden', count === 0);
  btn.textContent = `Import ${count} transaction${count !== 1 ? 's' : ''}`;
}

function resetPaste() {
  pasteState.transactions = [];
  document.getElementById('paste-preview').classList.add('hidden');
  document.getElementById('paste-import-btn').classList.add('hidden');
  document.getElementById('paste-textarea').value = '';
  document.getElementById('paste-textarea').focus();
}

async function importPasted() {
  const txs = pasteState.transactions;
  if (!txs.length) return;
  try {
    const res = await api('/transactions/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: txs }),
    });
    closePasteModal();
    toast(`Imported ${res.count} transaction${res.count !== 1 ? 's' : ''}`);
    if (res.months && res.months.length > 0) {
      const latestMonth = res.months[res.months.length - 1];
      state.currentMonth = latestMonth;
      await loadMonths();
      ensureMonthOption(latestMonth);
      await Promise.all([loadDashboard(), loadTransactions()]);
    }
  } catch (e) {
    toast(e.message, true);
  }
}

// ---- Paste parsers ----

const _MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Amount lines come in as "$115.06", "-$115.06" or "+$115.06".
const _AMOUNT_RE = /^([-+])?\s*\$\s*([\d,]+\.\d{2})$/;

// Mirrors _PAYMENT_KEYWORDS in main.py: description fragments that identify a
// credit as a card payment (paying down the balance) rather than a refund.
const _PAYMENT_KEYWORDS = [
  'payment thank you', 'autopay', 'auto pay', 'online payment', 'mobile pymt',
  'pymt', 'capital one mobile', 'capital one autopay', 'web payment',
  'electronic payment',
];

function _looksLikeCardPayment(description) {
  const d = (description || '').toLowerCase();
  return _PAYMENT_KEYWORDS.some(k => d.includes(k));
}

// Does this paste sign its charges with a leading '-'? If so, an unsigned
// amount is a credit; if not, every amount is a plain charge (older format).
function _signedAmountFormat(lines) {
  return lines.some(l => /^-\s*\$/.test(l));
}

// Map a displayed amount onto the app's storage convention: charges are
// positive expenses, card payments are 'payment' (excluded from spending),
// and refunds/returns are negative expenses so they net against their
// category and the monthly total — same rules as the CSV parsers in main.py.
function _pasteAmountFields(sign, value, description, signedFormat) {
  const isCredit = sign === '+' || (!sign && signedFormat);
  if (!isCredit) return { amount: value, type: 'expense' };
  if (_looksLikeCardPayment(description)) return { amount: value, type: 'payment' };
  return { amount: -value, type: 'expense' };
}

function parseChasePaste(text) {
  const dateRe = new RegExp(`^(${_MONTHS.join('|')})\\s+(\\d{1,2}),\\s+(\\d{4})$`);
  const amountRe = _AMOUNT_RE;
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  const signedFormat = _signedAmountFormat(lines);
  const transactions = [];

  // Chase pastes have two zones:
  // 1. Pending section: no dates, just description block + amount (preceded by a long disclaimer wall)
  // 2. Posted section: each transaction starts with a date line
  const firstDateIdx = lines.findIndex(l => dateRe.test(l));
  const pendingLines = lines.slice(0, firstDateIdx === -1 ? lines.length : firstDateIdx);
  const postedLines = firstDateIdx >= 0 ? lines.slice(firstDateIdx) : [];

  const today = new Date().toISOString().slice(0, 10);

  // --- Pending: scan for amount lines; description block is everything since last amount,
  //     filtered to short lines (junk disclaimer text is typically one very long line) ---
  let lastAmtIdx = -1;
  for (let i = 0; i < pendingLines.length; i++) {
    const amtMatch = pendingLines[i].match(amountRe);
    if (amtMatch) {
      const value = parseFloat(amtMatch[2].replace(/,/g, ''));
      const block = pendingLines.slice(lastAmtIdx + 1, i)
        .filter(l => l.length <= 70 && !/^pending/i.test(l));
      if (block.length > 0) {
        const description = _cleanChaseDesc(block[0]);
        let category = 'Uncategorized';
        for (let k = 1; k < block.length; k++) {
          if (block[k] === block[k - 1] && block[k] !== block[0]) category = _mapChaseCategory(block[k]);
        }
        const { amount, type } = _pasteAmountFields(amtMatch[1], value, description, signedFormat);
        transactions.push({ date: today, description, amount, type, source: 'chase', category, notes: 'Pending' });
      }
      lastAmtIdx = i;
    }
  }

  // --- Posted: each block starts at a date line ---
  let i = 0;
  while (i < postedLines.length) {
    const dateMatch = postedLines[i].match(dateRe);
    if (dateMatch) {
      const month = _MONTHS.indexOf(dateMatch[1]) + 1;
      const date = `${dateMatch[3]}-${String(month).padStart(2,'0')}-${dateMatch[2].padStart(2,'0')}`;
      const block = [];
      let amt = null;
      let j = i + 1;
      while (j < postedLines.length) {
        const line = postedLines[j];
        if (line.match(dateRe)) break;
        const amtMatch = line.match(amountRe);
        if (amtMatch) {
          amt = { sign: amtMatch[1], value: parseFloat(amtMatch[2].replace(/,/g, '')) };
          i = j;
          break;
        }
        block.push(line);
        j++;
      }
      if (block.length > 0 && amt !== null) {
        const description = _cleanChaseDesc(block[0]);
        let category = 'Uncategorized';
        for (let k = 1; k < block.length; k++) {
          if (block[k] === block[k - 1] && block[k] !== block[0]) category = _mapChaseCategory(block[k]);
        }
        const { amount, type } = _pasteAmountFields(amt.sign, amt.value, description, signedFormat);
        transactions.push({ date, description, amount, type, source: 'chase', category, notes: '' });
      }
    }
    i++;
  }

  return transactions;
}

function _cleanChaseDesc(desc) {
  const ci = desc.indexOf(',');
  if (ci > 0 && desc.slice(ci + 1).trim().includes('.')) return desc.slice(0, ci).trim();
  return desc;
}

function _mapChaseCategory(cat) {
  const map = {
    'shopping': 'Shopping', 'dining': 'Dining', 'food & drink': 'Dining',
    'groceries': 'Groceries', 'gas': 'Gas', 'travel': 'Travel',
    'entertainment': 'Entertainment', 'health & wellness': 'Health & Fitness',
    'bills & utilities': 'Bills & Utilities', 'personal': 'Personal Care',
    'automotive': 'Auto', 'gas & drive': 'Gas',
  };
  return map[cat.toLowerCase()] || cat;
}

function parseCapOnePaste(text) {
  const monthRe = new RegExp(`^(${_MONTHS.join('|')})$`);
  const amountRe = _AMOUNT_RE;
  const cardRe = /.+\.\.\.\d{4}$/;
  const rewardsRe = /^\d+x /i;
  const junk = new Set([
    'Total:', 'Posted Transactions Since Your Last Statement', 'Print',
    'Date', 'Description', 'Category', 'Card', 'Amount', 'Details',
    'Posted Transactions',
  ]);

  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  const signedFormat = _signedAmountFormat(lines);
  const transactions = [];
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line === 'Pending') {
      i++;
      const r = _capOneBlock(lines, i, junk, cardRe, rewardsRe, monthRe, amountRe);
      if (r) {
        const today = now.toISOString().slice(0, 10);
        const { amount, type } = _pasteAmountFields(r.sign, r.amount, r.description, signedFormat);
        transactions.push({ date: today, description: r.description, amount, type, source: 'capital_one', category: r.category, notes: 'Pending' });
        i = r.endIdx;
      }
      continue;
    }

    if (monthRe.test(line) && i + 1 < lines.length && /^\d{1,2}$/.test(lines[i + 1])) {
      const monthNum = _MONTHS.indexOf(line) + 1;
      const day = parseInt(lines[i + 1]);
      const year = monthNum > curMonth ? curYear - 1 : curYear;
      const date = `${year}-${String(monthNum).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      i += 2;
      const r = _capOneBlock(lines, i, junk, cardRe, rewardsRe, monthRe, amountRe);
      if (r) {
        const { amount, type } = _pasteAmountFields(r.sign, r.amount, r.description, signedFormat);
        transactions.push({ date, description: r.description, amount, type, source: 'capital_one', category: r.category, notes: '' });
        i = r.endIdx;
      }
      continue;
    }

    i++;
  }
  return transactions;
}

function _capOneBlock(lines, startIdx, junk, cardRe, rewardsRe, monthRe, amountRe) {
  let description = null;
  let category = null;
  let amount = null;
  let sign = null;
  let j = startIdx;

  while (j < lines.length) {
    const line = lines[j];
    const amtMatch = line.match(amountRe);
    if (amtMatch) {
      sign = amtMatch[1];
      amount = parseFloat(amtMatch[2].replace(/,/g, ''));
      j++;
      break;
    }
    if (line === 'Pending' || monthRe.test(line)) break;
    if (cardRe.test(line) || rewardsRe.test(line) || junk.has(line)) { j++; continue; }
    if (!description) description = line;
    else if (!category) category = _mapCapOneCategory(line);
    j++;
  }

  return (description && amount !== null)
    ? { description, category: category || 'Uncategorized', amount, sign, endIdx: j }
    : null;
}

function _mapCapOneCategory(cat) {
  const map = {
    'grocery': 'Groceries', 'dining': 'Dining', 'merchandise': 'Shopping',
    'gas/automotive': 'Gas', 'gas': 'Gas', 'utilities': 'Bills & Utilities',
    'travel': 'Travel', 'entertainment': 'Entertainment',
    'health': 'Health & Fitness', 'medical': 'Health & Fitness',
    'personal': 'Personal Care', 'other': 'Other', 'streaming': 'Subscriptions',
    'phone': 'Bills & Utilities', 'education': 'Other', 'insurance': 'Insurance',
    'home': 'Home',
  };
  return map[cat.toLowerCase()] || 'Uncategorized';
}

// ---- Utilities ----

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

let toastTimer = null;
function toast(msg, error = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast${error ? ' error' : ''}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.add('hidden'); }, 3500);
}
