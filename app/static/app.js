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
  allMerchants: [],
  selectedMerchants: new Set(),
};

function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---- Init ----

document.addEventListener('DOMContentLoaded', async () => {
  await loadMonths();
  await Promise.all([loadDashboard(), loadTransactions(), loadBills(), loadDefaultSettings()]);
});

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
  const res = await fetch('/api' + path, opts);
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
      <div class="chart-row">
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
  const val = prompt(`Set income for ${formatMonth(state.currentMonth)}:`, state.dashboard?.income || 0);
  if (val === null || val.trim() === '') return;
  const amount = parseFloat(val);
  if (isNaN(amount) || amount < 0) { toast('Invalid amount', true); return; }
  await api(`/income/${state.currentMonth}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ income: amount }) });
  await loadDashboard();
}

async function editSavings() {
  const val = prompt(`Set savings goal for ${formatMonth(state.currentMonth)}:`, state.dashboard?.savings_target || 0);
  if (val === null || val.trim() === '') return;
  const amount = parseFloat(val);
  if (isNaN(amount) || amount < 0) { toast('Invalid amount', true); return; }
  await api(`/savings/${state.currentMonth}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ savings_target: amount }) });
  await loadDashboard();
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
    updateApplySplitButton();
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
      <td class="amount-cell ${t.type === 'payment' ? 'credit' : ''}">${t.type === 'payment' ? '+' : ''}$${fmt(t.amount)}</td>
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
  if (!confirm(`Delete ${ids.length} transaction${ids.length !== 1 ? 's' : ''}?`)) return;
  await api('/transactions/bulk', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  state.allTransactions = state.allTransactions.filter(t => !state.selectedIds.has(t.id));
  state.selectedIds.clear();
  filterTransactions();
  updateCategoryFilter();
  updateApplySplitButton();
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
  if (!confirm('Delete this transaction?')) return;
  await api(`/transactions/${id}`, { method: 'DELETE' });
  state.allTransactions = state.allTransactions.filter(t => t.id !== id);
  state.selectedIds.delete(id);
  filterTransactions();
  updateCategoryFilter();
  updateApplySplitButton();
  updateBulkDeleteButton();
  if (document.getElementById('tab-dashboard').classList.contains('active')) await loadDashboard();
}

async function handleCSVUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  const split = document.getElementById('split-capone').checked;
  const replace = document.getElementById('replace-upload').checked;
  try {
    const res = await fetch(`/api/transactions/upload?split=${split}&replace=${replace}`, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Upload failed');
    const notes = [
      split && data.source === 'capital_one' ? '50/50 split' : '',
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

// ---- Split ----

async function onSplitToggle(checked) {
  await api('/settings/capital_one_split', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: checked ? 1 : 0 }) });
  updateApplySplitButton();
}

function updateApplySplitButton() {
  const checked = document.getElementById('split-capone').checked;
  const hasUnsplit = state.allTransactions.some(t => t.source === 'capital_one' && t.type === 'expense' && !t.is_split);
  document.getElementById('apply-split-btn').classList.toggle('hidden', !(checked && hasUnsplit));
}

async function applyCapOneSplit() {
  const data = await api(`/transactions/${state.currentMonth}/split-capital-one`, { method: 'POST' });
  if (data.count === 0) { toast('No un-split Capital One transactions found'); return; }
  toast(`Split ${data.count} Capital One transaction${data.count !== 1 ? 's' : ''} 50/50`);
  await Promise.all([loadDashboard(), loadTransactions()]);
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
      <button class="icon-btn delete" onclick="deleteBill(${b.id})">×</button>
    </div>
  `).join('');
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
  if (!confirm('Delete this bill?')) return;
  await api(`/bills/${id}`, { method: 'DELETE' });
  await loadBills();
  await loadDashboard();
}

// ---- Settings ----

async function loadDefaultSettings() {
  const [incomeData, savingsData, splitData] = await Promise.all([
    api('/settings/default_income'),
    api('/settings/default_savings'),
    api('/settings/capital_one_split'),
  ]);
  if (incomeData.value !== null) document.getElementById('default-income').value = incomeData.value;
  if (savingsData.value !== null) document.getElementById('default-savings').value = savingsData.value;
  if (splitData.value !== null) document.getElementById('split-capone').checked = splitData.value === 1;
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
    yearState.allMerchants = yearState.data.merchants;
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
      <div class="card-label">Total Saved</div>
      <div class="card-value savings-value">$${fmt(d.total_savings)}</div>
    </div>
    <div class="card summary-card ${d.total_net >= 0 ? 'positive' : 'negative'}">
      <div class="card-label">Net</div>
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

function filterMerchants() {
  const q = document.getElementById('merchant-search').value.toLowerCase();
  const filtered = q
    ? yearState.allMerchants.filter(m => m.description.toLowerCase().includes(q))
    : yearState.allMerchants;
  renderMerchants(filtered);
}

function renderMerchants(merchants) {
  const el = document.getElementById('merchant-list');
  if (!merchants || merchants.length === 0) {
    el.innerHTML = '<p class="empty">No merchants found.</p>';
    return;
  }

  el.innerHTML = merchants.map(m => {
    const selected = yearState.selectedMerchants.has(m.description);
    return `
      <div class="merchant-row ${selected ? 'selected' : ''}">
        <input type="checkbox" class="merchant-check" onchange="toggleMerchant('${esc(m.description)}', this.checked)" ${selected ? 'checked' : ''}>
        <button class="merchant-name-btn" onclick="showMerchantTransactions('${esc(m.description)}')" title="View transactions">${esc(m.description)}</button>
        <span class="merchant-count">${m.count}×</span>
        <span class="merchant-total">$${fmt(m.total)}</span>
      </div>`;
  }).join('');

  updateRenameBar();
}

function toggleMerchant(description, checked) {
  if (checked) yearState.selectedMerchants.add(description);
  else yearState.selectedMerchants.delete(description);
  updateRenameBar();
  // Update row highlight without full re-render
  const rows = document.querySelectorAll('.merchant-row');
  rows.forEach(row => {
    const name = row.querySelector('.merchant-name')?.textContent;
    if (name) row.classList.toggle('selected', yearState.selectedMerchants.has(name));
  });
}

function updateRenameBar() {
  const bar = document.getElementById('rename-bar');
  const count = yearState.selectedMerchants.size;
  bar.classList.toggle('hidden', count === 0);
  document.getElementById('selected-merchant-count').textContent =
    `${count} merchant${count !== 1 ? 's' : ''} selected`;
}

function clearMerchantSelection() {
  yearState.selectedMerchants.clear();
  document.getElementById('rename-input').value = '';
  filterMerchants();
}

async function applyRename() {
  const toName = document.getElementById('rename-input').value.trim();
  if (!toName) { toast('Enter a new name', true); return; }
  const fromNames = [...yearState.selectedMerchants];
  if (fromNames.length === 0) return;

  const data = await api('/merchants/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_names: fromNames, to_name: toName }),
  });

  toast(`Renamed ${data.count} transaction${data.count !== 1 ? 's' : ''} to "${toName}"`);
  yearState.selectedMerchants.clear();
  document.getElementById('rename-input').value = '';
  await loadAnnualSummary();
  // Refresh transactions if viewing the same data
  await loadTransactions();
  if (document.getElementById('tab-dashboard').classList.contains('active')) await loadDashboard();
}

// ---- Merchant transactions modal ----

async function showMerchantTransactions(name) {
  const data = await api(`/merchants/transactions?name=${encodeURIComponent(name)}&year=${yearState.currentYear}`);
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
            <tr><th>Date</th><th>Month</th><th>Amount</th><th>Category</th><th>Notes</th></tr>
          </thead>
          <tbody>
            ${txs.map(t => `
              <tr>
                <td style="white-space:nowrap">${t.date}</td>
                <td>${formatMonthShort(t.month_year)}</td>
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

// ---- Edit Modal ----

let _editingTxId = null;

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
    updateApplySplitButton();
    await loadDashboard();
    toast('Transaction updated');
    closeModal();
  } catch (e) {
    toast(e.message, true);
  }
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
