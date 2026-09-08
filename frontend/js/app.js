const state = {
  config: null,
  credentials: null,
  currentSale: null,
  pollTimer: null,
  autoResetTimer: null,
  lastSale: null,
};

const els = {
  amountInput: document.getElementById('saleAmountInput'),
  lastSale: document.getElementById('lastSale'),
  paymentModal: document.getElementById('paymentModal'),
  paymentStatusIcon: document.getElementById('paymentStatusIcon'),
  paymentModeLabel: document.getElementById('paymentModeLabel'),
  paymentTitle: document.getElementById('paymentTitle'),
  paymentAmount: document.getElementById('paymentAmount'),
  paymentMessage: document.getElementById('paymentMessage'),
  transactionLine: document.getElementById('transactionLine'),
  terminalState: document.getElementById('terminalState'),
  toast: document.getElementById('toast'),
  salesList: document.getElementById('salesList'),
  terminalIdInput: document.getElementById('terminalIdInput'),
  currentTerminalCard: document.getElementById('currentTerminalCard'),
  terminalsList: document.getElementById('terminalsList'),
  credentialStatus: document.getElementById('credentialStatus'),
  publicKeyInput: document.getElementById('publicKeyInput'),
  accessTokenInput: document.getElementById('accessTokenInput'),
  clientIdInput: document.getElementById('clientIdInput'),
  clientSecretInput: document.getElementById('clientSecretInput'),
  webhookSecretInput: document.getElementById('webhookSecretInput'),
};

const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  await Promise.all([loadConfig(), loadCredentialStatus(), loadDashboard(), loadSales(), loadCashSummary()]);
  await loadLocalTerminals();
  renderPaymentButtons();
  els.amountInput.focus();
});

function bindEvents() {
  document.querySelectorAll('.nav-button').forEach((button) => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });

  els.amountInput.addEventListener('input', renderPaymentButtons);
  els.amountInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && getAmountCents() > 0) {
      event.preventDefault();
      startSalePayment('CARD');
    }
  });

  document.querySelectorAll('[data-quick-amount]').forEach((button) => {
    button.addEventListener('click', () => {
      const cents = getAmountCents() + Number(button.dataset.quickAmount);
      els.amountInput.value = centsToInputValue(cents);
      renderPaymentButtons();
    });
  });

  document.getElementById('refreshSalesButton').addEventListener('click', refreshSalesView);
  document.getElementById('cardPaymentButton').addEventListener('click', () => startSalePayment('CARD'));
  document.getElementById('pixPaymentButton').addEventListener('click', () => startSalePayment('PIX'));
  document.getElementById('cancelPaymentButton').addEventListener('click', cancelPayment);
  document.getElementById('newSaleButton').addEventListener('click', resetSale);
  document.getElementById('closeCashButton').addEventListener('click', closeCashRegister);
  document.getElementById('saveTerminalButton').addEventListener('click', saveTerminal);
  document.getElementById('setupPdvButton').addEventListener('click', setupActiveTerminalPdv);
  document.getElementById('syncTerminalsButton').addEventListener('click', syncTerminals);
  document.getElementById('reloadCredentialsButton').addEventListener('click', loadCredentialStatus);
  document.getElementById('saveCredentialsButton').addEventListener('click', saveCredentials);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) return null;

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || 'Falha na comunicacao com o servidor.');
  }
  return data;
}

async function loadConfig() {
  const data = await api('/api/config');
  state.config = data.mercadopago;

  const dot = els.terminalState.querySelector('.status-dot');
  dot.classList.toggle('ok', state.config.terminal_configured);
  els.terminalState.querySelector('span:last-child').textContent = state.config.terminal_configured
    ? 'Maquininha configurada'
    : 'Maquininha nao configurada';

  els.terminalIdInput.value = state.config.terminal_id || '';
  renderCurrentTerminal();
  renderPaymentButtons();
}

async function loadCredentialStatus() {
  const data = await api('/api/mercadopago/credentials');
  state.credentials = data.credentials;
  renderCredentialStatus();
}

function renderCredentialStatus() {
  if (!state.credentials) {
    els.credentialStatus.innerHTML = '<div class="empty-state compact-empty">Credenciais nao carregadas.</div>';
    return;
  }

  const entries = [
    ['Public Key', state.credentials.public_key],
    ['Access Token', state.credentials.access_token],
    ['Client ID', state.credentials.client_id],
    ['Client Secret', state.credentials.client_secret],
    ['Webhook Secret', state.credentials.webhook_secret],
    ['Terminal ID', state.credentials.terminal_id],
  ];

  els.credentialStatus.innerHTML = entries
    .map(([label, credential]) => {
      const configured = Boolean(credential?.configured);
      const value = configured ? credential.masked : 'Pendente';
      return `
        <div class="credential-chip ${configured ? 'ok' : ''}">
          <span>${label}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `;
    })
    .join('');
}

async function saveCredentials() {
  const payload = collectCredentialPayload();
  const providerTerminalId = els.terminalIdInput.value.trim();
  if (providerTerminalId) payload.terminal_id = providerTerminalId;

  if (Object.keys(payload).length === 0) {
    showToast('Informe ao menos uma credencial.');
    return;
  }

  try {
    const { credentials, terminal } = await api('/api/mercadopago/credentials', {
      method: 'PUT',
      body: payload,
    });

    state.credentials = credentials;
    clearCredentialInputs();
    renderCredentialStatus();

    if (terminal) {
      state.config = {
        ...state.config,
        terminal_configured: terminal.configured,
        terminal_id: terminal.provider_terminal_id,
      };
      els.terminalIdInput.value = terminal.provider_terminal_id || '';
      renderCurrentTerminal();
      updateSidebarTerminalState();
    }

    renderPaymentButtons();
    await loadLocalTerminals();
    showToast('Credenciais salvas no backend.');
  } catch (error) {
    showToast(error.message);
  }
}

function collectCredentialPayload() {
  return {
    ...(els.publicKeyInput.value.trim() ? { public_key: els.publicKeyInput.value.trim() } : {}),
    ...(els.accessTokenInput.value.trim() ? { access_token: els.accessTokenInput.value.trim() } : {}),
    ...(els.clientIdInput.value.trim() ? { client_id: els.clientIdInput.value.trim() } : {}),
    ...(els.clientSecretInput.value.trim() ? { client_secret: els.clientSecretInput.value.trim() } : {}),
    ...(els.webhookSecretInput.value.trim() ? { webhook_secret: els.webhookSecretInput.value.trim() } : {}),
  };
}

function clearCredentialInputs() {
  els.publicKeyInput.value = '';
  els.accessTokenInput.value = '';
  els.clientIdInput.value = '';
  els.clientSecretInput.value = '';
  els.webhookSecretInput.value = '';
}

function renderCurrentTerminal() {
  const terminalId = state.config?.terminal_id;
  els.currentTerminalCard.innerHTML = terminalId
    ? `
      <span>Mercado Pago Point</span>
      <strong>${escapeHtml(terminalId)}</strong>
      <span class="muted">Status local: configurada</span>
    `
    : `
      <span>Mercado Pago Point</span>
      <strong>Nenhuma maquininha cadastrada</strong>
      <span class="muted">Salve o ID do terminal para enviar cobrancas.</span>
    `;
}

function renderPaymentButtons() {
  const amountCents = getAmountCents();
  const hasTerminal = Boolean(state.config?.terminal_configured);
  document.getElementById('cardPaymentButton').disabled = amountCents <= 0 || !hasTerminal;
  document.getElementById('pixPaymentButton').disabled =
    amountCents <= 0 || !hasTerminal || !state.config?.pix_qr_enabled;
}

async function startSalePayment(paymentMethod) {
  const amountCents = getAmountCents();
  if (amountCents <= 0) return;

  showPaymentModal({
    status: 'pending',
    title: 'Pagamento em andamento',
    message: 'Enviando cobranca para a Point Smart...',
    paymentMethod,
  });

  try {
    const checkoutResponse = await api('/api/checkout/point', {
      method: 'POST',
      body: { amount_cents: amountCents, payment_method: paymentMethod },
    });

    state.currentSale = checkoutResponse.sale;
    showPaymentModal({
      status: 'pending',
      title: 'Pagamento em andamento',
      message: 'Aguardando pagamento na Point Smart...',
      paymentMethod,
      amount: state.currentSale.total,
    });
    startPollingStatus();
  } catch (error) {
    showPaymentModal({
      status: 'failed',
      title: 'Nao foi possivel iniciar',
      message: error.message,
      paymentMethod,
    });
  }
}

function startPollingStatus() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (!state.currentSale) return;
    try {
      const response = await api(`/api/sales/${state.currentSale.id}/status`);
      state.currentSale = response.sale;
      handleSaleStatus(state.currentSale);
    } catch (error) {
      showToast(error.message);
    }
  }, 2500);
}

function handleSaleStatus(sale) {
  if (sale.status === 'PENDING') return;

  clearInterval(state.pollTimer);
  state.pollTimer = null;
  state.lastSale = sale;

  if (sale.status === 'APPROVED') {
    showPaymentModal({
      status: 'approved',
      title: 'Pagamento aprovado',
      message: 'Venda confirmada automaticamente pelo Mercado Pago.',
      paymentMethod: sale.payment_method,
      amount: sale.total,
      transactionId: sale.payment?.transaction_id || sale.provider_payment_id,
    });
    els.amountInput.value = '';
    renderPaymentButtons();
    refreshSalesView();
    renderLastSale();
    clearTimeout(state.autoResetTimer);
    state.autoResetTimer = setTimeout(resetSale, 4500);
    return;
  }

  const messages = {
    REJECTED: 'Pagamento recusado. A venda nao entrou no caixa.',
    CANCELLED: 'Pagamento cancelado. A venda nao entrou no caixa.',
    EXPIRED: 'A cobranca expirou. Informe o valor novamente para tentar de novo.',
    REFUNDED: 'Pagamento estornado.',
    ACTION_REQUIRED: 'Verifique o status final no terminal e no painel Mercado Pago.',
  };

  showPaymentModal({
    status: 'failed',
    title: statusLabel(sale.status),
    message: messages[sale.status] || 'Pagamento nao aprovado.',
    paymentMethod: sale.payment_method,
    amount: sale.total,
  });
  renderLastSale();
  refreshSalesView();
}

async function cancelPayment() {
  if (!state.currentSale || state.currentSale.status !== 'PENDING') {
    hidePaymentModal();
    return;
  }

  try {
    const response = await api(`/api/sales/${state.currentSale.id}/cancel`, { method: 'POST' });
    state.currentSale = response.sale;
    handleSaleStatus(state.currentSale);
  } catch (error) {
    showToast(error.message);
  }
}

function resetSale() {
  state.currentSale = null;
  clearInterval(state.pollTimer);
  clearTimeout(state.autoResetTimer);
  state.pollTimer = null;
  state.autoResetTimer = null;
  hidePaymentModal();
  switchView('pos');
  els.amountInput.focus();
}

function renderLastSale() {
  if (!state.lastSale) {
    els.lastSale.innerHTML = '<span>Nenhuma transacao nesta sessao.</span>';
    return;
  }

  const transaction = state.lastSale.payment?.transaction_id || state.lastSale.provider_payment_id || '-';
  els.lastSale.innerHTML = `
    <span>${statusLabel(state.lastSale.status)}</span>
    <strong>${currency.format(state.lastSale.total)}</strong>
    <span>Transacao: ${escapeHtml(transaction)}</span>
  `;
}

async function refreshSalesView() {
  await Promise.all([loadDashboard(), loadSales(), loadCashSummary()]);
}

async function loadDashboard() {
  const { dashboard } = await api('/api/dashboard');
  document.getElementById('metricsGrid').innerHTML = [
    ['Faturamento do dia', currency.format(dashboard.revenue_cents / 100)],
    ['Quantidade de vendas', dashboard.sales_count],
    ['Vendas aprovadas', dashboard.approved_sales],
    ['Vendas recusadas', dashboard.rejected_sales],
    ['Pagamentos em cartao', currency.format(dashboard.card_cents / 100)],
    ['Pagamentos em Pix', currency.format(dashboard.pix_cents / 100)],
    ['Ticket medio', currency.format(dashboard.average_ticket_cents / 100)],
    ['Canceladas/estornadas', `${dashboard.cancelled_sales}/${dashboard.refunded_sales}`],
  ]
    .map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`)
    .join('');

  document.getElementById('cashMovements').innerHTML = dashboard.cash_movements.length
    ? dashboard.cash_movements
        .map(
          (movement) => `
            <div class="compact-row">
              <span>${movement.type} · ${movement.payment_method || '-'}</span>
              <strong>${currency.format(movement.amount_cents / 100)}</strong>
            </div>
          `,
        )
        .join('')
    : '<div class="empty-state">Sem movimentacoes hoje.</div>';
}

async function loadSales() {
  const { sales } = await api('/api/sales?limit=40');
  els.salesList.innerHTML = sales.length
    ? sales
        .map(
          (sale) => `
            <div class="compact-row">
              <div>
                <strong>${currency.format(sale.total)}</strong>
                <div class="muted">${formatDateTime(sale.created_at)} · ${sale.payment_method}</div>
              </div>
              <span class="sale-status ${sale.status}">${statusLabel(sale.status)}</span>
            </div>
          `,
        )
        .join('')
    : '<div class="empty-state">Nenhuma venda registrada.</div>';
}

async function loadCashSummary() {
  const current = await api('/api/cash-registers/current');
  const summary = await api(`/api/cash-registers/${current.cash_register.id}/summary`);
  renderCashSummary(summary.summary);
}

function renderCashSummary(summary) {
  const entries = [
    ['Faturamento bruto', summary.gross_revenue_cents],
    ['Cartao', summary.card_cents],
    ['Pix', summary.pix_cents],
    ['Dinheiro', summary.cash_cents],
    ['Total recebido', summary.total_received_cents],
    ['Total cancelado', summary.total_cancelled_cents],
    ['Total estornado', summary.total_refunded_cents],
    ['Vendas aprovadas', summary.sales.approved, false],
    ['Vendas recusadas', summary.sales.rejected, false],
  ];

  document.getElementById('cashSummary').innerHTML = entries
    .map(([label, value, money = true]) => {
      const display = money ? currency.format(value / 100) : value;
      return `<div class="cash-box"><span>${label}</span><strong>${display}</strong></div>`;
    })
    .join('');
}

async function closeCashRegister() {
  const current = await api('/api/cash-registers/current');
  await api(`/api/cash-registers/${current.cash_register.id}/close`, { method: 'POST' });
  showToast('Caixa fechado.');
  await loadCashSummary();
}

async function saveTerminal() {
  try {
    const providerTerminalId = els.terminalIdInput.value.trim();
    const { terminal } = await api('/api/terminals', {
      method: 'POST',
      body: { provider_terminal_id: providerTerminalId },
    });
    state.config = {
      ...state.config,
      terminal_configured: terminal.configured,
      terminal_id: terminal.provider_terminal_id,
    };
    renderCurrentTerminal();
    updateSidebarTerminalState();
    renderPaymentButtons();
    await loadLocalTerminals();
    showToast('Maquininha salva.');
  } catch (error) {
    showToast(error.message);
  }
}

async function setupActiveTerminalPdv() {
  const providerTerminalId = els.terminalIdInput.value.trim();
  if (!providerTerminalId) {
    showToast('Informe o ID da maquininha.');
    return;
  }

  try {
    await api(`/api/terminals/${encodeURIComponent(providerTerminalId)}/mode`, {
      method: 'PATCH',
      body: { operating_mode: 'PDV' },
    });
    await loadConfig();
    await loadLocalTerminals();
    showToast('Modo PDV solicitado ao Mercado Pago.');
  } catch (error) {
    showToast(error.message);
  }
}

async function syncTerminals() {
  try {
    const { terminals } = await api('/api/terminals?sync=true');
    renderTerminals(terminals);
    showToast('Terminais sincronizados.');
  } catch (error) {
    showToast(error.message);
  }
}

async function loadLocalTerminals() {
  const { terminals } = await api('/api/terminals');
  renderTerminals(terminals);
}

function renderTerminals(terminals) {
  els.terminalsList.innerHTML = terminals.length
    ? terminals
        .map(
          (terminal) => `
            <div class="compact-row">
              <div class="terminal-id">
                <strong>${escapeHtml(terminal.provider_terminal_id)}</strong>
                <div class="muted">${terminal.operating_mode || 'Modo nao sincronizado'}</div>
              </div>
              <button class="ghost-button small" data-use-terminal="${escapeHtml(terminal.provider_terminal_id)}">Usar</button>
            </div>
          `,
        )
        .join('')
    : '<div class="empty-state">Nenhum terminal salvo.</div>';

  els.terminalsList.querySelectorAll('[data-use-terminal]').forEach((button) => {
    button.addEventListener('click', () => {
      els.terminalIdInput.value = button.dataset.useTerminal;
      saveTerminal();
    });
  });
}

function updateSidebarTerminalState() {
  const dot = els.terminalState.querySelector('.status-dot');
  dot.classList.toggle('ok', state.config.terminal_configured);
  els.terminalState.querySelector('span:last-child').textContent = state.config.terminal_configured
    ? 'Maquininha configurada'
    : 'Maquininha nao configurada';
}

function showPaymentModal({ status, title, message, paymentMethod, amount = 0, transactionId }) {
  els.paymentModal.classList.remove('hidden');
  els.paymentStatusIcon.className = `payment-icon ${status}`;
  els.paymentTitle.textContent = title;
  els.paymentMessage.textContent = message;
  els.paymentModeLabel.textContent = paymentMethod === 'PIX' ? 'Pix' : 'Cartao';
  els.paymentAmount.textContent = currency.format(amount);
  document.getElementById('cancelPaymentButton').classList.toggle('hidden', status !== 'pending');
  document.getElementById('newSaleButton').classList.toggle('hidden', status === 'pending');
  els.transactionLine.classList.toggle('hidden', !transactionId);
  els.transactionLine.textContent = transactionId ? `Transacao: ${transactionId}` : '';
}

function hidePaymentModal() {
  els.paymentModal.classList.add('hidden');
}

function switchView(view) {
  document.querySelectorAll('.nav-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
  document.querySelectorAll('.view').forEach((section) => {
    section.classList.toggle('active', section.id === `view-${view}`);
  });

  if (view === 'sales') refreshSalesView().catch((error) => showToast(error.message));
  if (view === 'cash') loadCashSummary().catch((error) => showToast(error.message));
}

function getAmountCents() {
  const raw = els.amountInput.value.trim();
  if (!raw) return 0;

  const sanitized = raw.replace(/[^\d.,]/g, '');
  const lastComma = sanitized.lastIndexOf(',');
  const lastDot = sanitized.lastIndexOf('.');
  const decimalIndex = Math.max(lastComma, lastDot);

  if (decimalIndex >= 0) {
    const integerPart = sanitized.slice(0, decimalIndex).replace(/\D/g, '') || '0';
    const decimalPart = sanitized.slice(decimalIndex + 1).replace(/\D/g, '').padEnd(2, '0').slice(0, 2);
    return Number.parseInt(integerPart, 10) * 100 + Number.parseInt(decimalPart, 10);
  }

  return Number.parseInt(sanitized.replace(/\D/g, '') || '0', 10) * 100;
}

function centsToInputValue(cents) {
  return currency.format(cents / 100).replace('R$', '').trim();
}

function statusLabel(status) {
  return {
    PENDING: 'Pendente',
    APPROVED: 'Aprovada',
    REJECTED: 'Recusada',
    CANCELLED: 'Cancelada',
    EXPIRED: 'Expirada',
    REFUNDED: 'Estornada',
    ACTION_REQUIRED: 'Verificar',
  }[status] || status;
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value.replace(' ', 'T')).toLocaleString('pt-BR');
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  setTimeout(() => els.toast.classList.add('hidden'), 4200);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
