const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

const routes = {
  login: '/login',
  register: '/cadastro',
  verify: '/verificar-email',
  forgot: '/esqueci-senha',
  reset: '/redefinir-senha',
  dashboard: '/',
  sales: '/vendas',
  reports: '/relatorios',
  mercadopago: '/mercado-pago',
  settings: '/configuracoes',
  account: '/minha-conta',
};

const authViewByPath = {
  '/login': 'login',
  '/cadastro': 'register',
  '/verificar-email': 'verify',
  '/esqueci-senha': 'forgot',
  '/redefinir-senha': 'reset',
};

const appViewByPath = {
  '/': 'dashboard',
  '/vendas': 'sales',
  '/relatorios': 'reports',
  '/mercado-pago': 'mercadopago',
  '/configuracoes': 'settings',
  '/minha-conta': 'account',
};

const state = {
  csrfToken: null,
  dashboard: null,
  mercadoPago: null,
  pendingVerificationEmail: '',
  pollTimer: null,
  saleIds: new Set(),
  sales: [],
  salesLoaded: false,
  user: null,
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  collectElements();
  bindEvents();
  boot().catch((error) => showFatal(error.message));
});

function collectElements() {
  [
    'accountAvatar',
    'accountEmail',
    'accountName',
    'accountVerified',
    'appShell',
    'authShell',
    'cashMovements',
    'cashSummary',
    'closeCashButton',
    'connectMercadoPagoButton',
    'currentTerminalCard',
    'dashboardConnectionSummary',
    'disconnectMercadoPagoButton',
    'forgotEmailInput',
    'forgotPasswordForm',
    'latestSalesList',
    'loginEmailInput',
    'loginForm',
    'loginPasswordInput',
    'logoutButton',
    'mercadoPagoStatus',
    'metricsGrid',
    'passwordRequirements',
    'passwordStrengthBar',
    'registerEmailInput',
    'registerForm',
    'registerNameInput',
    'registerPasswordConfirmInput',
    'registerPasswordInput',
    'resendVerificationButton',
    'resetPasswordConfirmInput',
    'resetPasswordForm',
    'resetPasswordInput',
    'salesList',
    'salesMinAmountInput',
    'salesPaymentFilter',
    'salesPeriodFilter',
    'salesSearchInput',
    'salesStatusFilter',
    'sidebar',
    'sidebarBackdrop',
    'sidebarToggle',
    'syncTerminalsButton',
    'terminalState',
    'terminalsList',
    'testConnectionButton',
    'toast',
    'userFirstName',
    'verificationEmailInput',
    'verificationMessage',
    'welcomeSubtitle',
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function bindEvents() {
  document.querySelectorAll('[data-auth-view]').forEach((button) => {
    button.addEventListener('click', () => showAuthView(button.dataset.authView, { push: true }));
  });

  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => showAppView(button.dataset.view, { push: true }));
  });

  document.querySelectorAll('[data-view-target]').forEach((button) => {
    button.addEventListener('click', () => showAppView(button.dataset.viewTarget, { push: true }));
  });

  document.querySelectorAll('[data-toggle-password]').forEach((button) => {
    button.addEventListener('click', () => togglePassword(button));
  });

  els.loginForm?.addEventListener('submit', handleLogin);
  els.registerForm?.addEventListener('submit', handleRegister);
  els.forgotPasswordForm?.addEventListener('submit', handleForgotPassword);
  els.resetPasswordForm?.addEventListener('submit', handleResetPassword);
  els.registerPasswordInput?.addEventListener('input', renderPasswordStrength);
  els.resendVerificationButton?.addEventListener('click', handleResendVerification);

  els.refreshSalesButton?.addEventListener('click', () => refreshPrivateData({ showSuccess: true }));
  els.closeCashButton?.addEventListener('click', closeCashRegister);
  els.connectMercadoPagoButton?.addEventListener('click', () => {
    window.location.href = '/api/mercadopago/connect';
  });
  els.testConnectionButton?.addEventListener('click', testMercadoPagoConnection);
  els.disconnectMercadoPagoButton?.addEventListener('click', disconnectMercadoPago);
  els.syncTerminalsButton?.addEventListener('click', syncTerminals);
  els.logoutButton?.addEventListener('click', () => logout({ pushLogin: true }));

  [
    els.salesSearchInput,
    els.salesPeriodFilter,
    els.salesStatusFilter,
    els.salesPaymentFilter,
    els.salesMinAmountInput,
  ].forEach((input) => {
    input?.addEventListener('input', renderSalesList);
    input?.addEventListener('change', renderSalesList);
  });

  els.sidebarToggle?.addEventListener('click', openSidebar);
  els.sidebarBackdrop?.addEventListener('click', closeSidebar);

  window.addEventListener('popstate', () => {
    if (state.user) {
      showAppView(resolveAppViewFromPath(), { push: false });
      return;
    }
    showAuthView(resolveAuthViewFromPath(), { push: false });
  });
}

async function boot() {
  if (window.location.pathname === '/logout') {
    await logout({ pushLogin: true, silent: true });
    return;
  }

  const session = await api('/api/auth/me', { ignoreAuthRedirect: true });
  if (session.authenticated) {
    state.user = session.user;
    state.csrfToken = session.csrf_token || readCookie('big_lanche_csrf');
    const appView = resolveAppViewFromPath();
    showAppView(appView, { push: false });
    if (authViewByPath[window.location.pathname]) {
      history.replaceState({}, '', routes[appView] || routes.dashboard);
    }
    renderUser();
    await refreshPrivateData({ initial: true });
    startPolling();

    if (new URLSearchParams(window.location.search).get('connected') === '1') {
      showToast('Mercado Pago conectado.', 'success');
      history.replaceState({}, '', routes.mercadopago);
    }
    return;
  }

  const authView = resolveAuthViewFromPath();
  showAuthView(authView, { push: false });

  if (authView === 'verify') {
    await verifyEmailFromUrl();
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const submitButton = event.submitter;

  await withButtonLoading(submitButton, 'Entrando...', async () => {
    try {
      const response = await api('/api/auth/login', {
        method: 'POST',
        body: {
          email: els.loginEmailInput.value,
          password: els.loginPasswordInput.value,
        },
        ignoreAuthRedirect: true,
      });

      state.user = response.user;
      state.csrfToken = response.csrf_token || readCookie('big_lanche_csrf');
      renderUser();
      showAppView('dashboard', { push: true });
      await refreshPrivateData({ initial: true });
      startPolling();
      showToast('Login realizado com segurança.', 'success');
    } catch (error) {
      if (error.code === 'EMAIL_NOT_VERIFIED') {
        state.pendingVerificationEmail = normalizeEmail(els.loginEmailInput.value);
        els.verificationEmailInput.value = state.pendingVerificationEmail;
        els.verificationMessage.textContent = 'Confirme seu e-mail antes de entrar. Você pode reenviar o link abaixo.';
        showAuthView('verify', { push: true });
        return;
      }
      showToast(error.message, 'danger');
    }
  });
}

async function handleRegister(event) {
  event.preventDefault();
  const submitButton = event.submitter;

  await withButtonLoading(submitButton, 'Criando conta...', async () => {
    try {
      const response = await api('/api/auth/register', {
        method: 'POST',
        body: {
          name: els.registerNameInput.value,
          email: els.registerEmailInput.value,
          password: els.registerPasswordInput.value,
          password_confirmation: els.registerPasswordConfirmInput.value,
        },
        ignoreAuthRedirect: true,
      });

      state.pendingVerificationEmail = normalizeEmail(els.registerEmailInput.value);
      els.verificationEmailInput.value = state.pendingVerificationEmail;
      els.verificationMessage.textContent = response.masked_email
        ? `Enviamos um link de confirmação para ${response.masked_email}.`
        : 'Enviamos um link de confirmação para o endereço informado.';
      showAuthView('verify', { push: true });
      showToast('Cadastro criado. Verifique seu e-mail.', 'success');
      els.registerForm.reset();
      renderPasswordStrength();
    } catch (error) {
      showToast(error.message, 'danger');
    }
  });
}

async function handleForgotPassword(event) {
  event.preventDefault();
  const submitButton = event.submitter;

  await withButtonLoading(submitButton, 'Enviando...', async () => {
    try {
      await api('/api/auth/forgot-password', {
        method: 'POST',
        body: { email: els.forgotEmailInput.value },
        ignoreAuthRedirect: true,
      });
      showToast('Se o e-mail existir, enviaremos as instruções.', 'success');
      els.forgotPasswordForm.reset();
    } catch (error) {
      showToast(error.message, 'danger');
    }
  });
}

async function handleResetPassword(event) {
  event.preventDefault();
  const submitButton = event.submitter;
  const token = new URLSearchParams(window.location.search).get('token');

  await withButtonLoading(submitButton, 'Redefinindo...', async () => {
    try {
      await api('/api/auth/reset-password', {
        method: 'POST',
        body: {
          token,
          password: els.resetPasswordInput.value,
          password_confirmation: els.resetPasswordConfirmInput.value,
        },
        ignoreAuthRedirect: true,
      });
      els.resetPasswordForm.reset();
      showAuthView('login', { push: true });
      showToast('Senha redefinida. Entre novamente.', 'success');
    } catch (error) {
      showToast(error.message, 'danger');
    }
  });
}

async function verifyEmailFromUrl() {
  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) return;

  try {
    await api(`/api/auth/verify-email?token=${encodeURIComponent(token)}`, { ignoreAuthRedirect: true });
    els.verificationMessage.textContent = 'E-mail confirmado. Agora você já pode entrar.';
    showToast('E-mail verificado com sucesso.', 'success');
    history.replaceState({}, '', routes.login);
    setTimeout(() => showAuthView('login', { push: true }), 1000);
  } catch (error) {
    els.verificationMessage.textContent = error.message;
    showToast(error.message, 'danger');
  }
}

async function handleResendVerification() {
  const email = normalizeEmail(els.verificationEmailInput.value || state.pendingVerificationEmail);
  if (!email) {
    showToast('Informe o e-mail para reenviar a confirmação.', 'warning');
    return;
  }

  await withButtonLoading(els.resendVerificationButton, 'Reenviando...', async () => {
    try {
      await api('/api/auth/resend-verification', {
        method: 'POST',
        body: { email },
        ignoreAuthRedirect: true,
      });
      showToast('Se houver uma conta pendente, enviaremos outro link.', 'success');
    } catch (error) {
      showToast(error.message, 'danger');
    }
  });
}

async function logout({ pushLogin = true, silent = false } = {}) {
  try {
    if (state.user) {
      await api('/api/auth/logout', { method: 'POST', ignoreAuthRedirect: true });
    }
  } catch (error) {
    if (!silent) showToast(error.message, 'warning');
  }

  state.user = null;
  state.csrfToken = null;
  state.sales = [];
  state.saleIds = new Set();
  state.salesLoaded = false;
  stopPolling();
  showAuthView('login', { push: pushLogin });
}

async function refreshPrivateData({ initial = false, showSuccess = false } = {}) {
  if (!state.user) return;
  if (initial) renderLoadingState();

  try {
    await Promise.all([loadDashboard(), loadSales(), loadMercadoPagoStatus(), loadCashSummary()]);
    if (showSuccess) showToast('Painel atualizado.', 'success');
  } catch (error) {
    showToast(error.message, 'danger');
  }
}

async function loadDashboard() {
  const { dashboard } = await api('/api/dashboard');
  state.dashboard = dashboard;
  renderDashboard(dashboard);
}

async function loadSales() {
  const { sales } = await api('/api/sales?limit=200');
  detectNewSales(sales || []);
  state.sales = sales || [];
  renderLatestSales();
  renderSalesList();
}

async function loadMercadoPagoStatus() {
  const { mercado_pago: mercadoPago } = await api('/api/mercadopago/status');
  state.mercadoPago = mercadoPago;
  renderMercadoPagoStatus();
  renderConnectionSummary();
  updateSidebarTerminalState();
}

async function loadCashSummary() {
  const current = await api('/api/cash-registers/current');
  const summary = await api(`/api/cash-registers/${current.cash_register.id}/summary`);
  renderCashSummary(summary.summary);
}

function renderDashboard(dashboard) {
  const cards = [
    ['Vendas hoje', dashboard.sales_count || 0, 'Total recebido pelo webhook hoje'],
    ['Faturamento', currency.format((dashboard.revenue_cents || 0) / 100), 'Apenas vendas aprovadas'],
    ['Ticket médio', currency.format((dashboard.average_ticket_cents || 0) / 100), 'Baseado em vendas aprovadas'],
    ['Vendas aprovadas', dashboard.approved_sales || 0, 'Confirmadas pelo Mercado Pago'],
    ['Vendas recusadas', dashboard.rejected_sales || 0, 'Não entram no caixa'],
    ['Canceladas/estornadas', `${dashboard.cancelled_sales || 0}/${dashboard.refunded_sales || 0}`, 'Controle operacional'],
  ];

  els.metricsGrid.innerHTML = cards
    .map(
      ([label, value, helper]) => `
        <div class="metric">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <small>${escapeHtml(helper)}</small>
        </div>
      `,
    )
    .join('');

  renderCashMovements(dashboard.cash_movements || []);
}

function renderLatestSales() {
  const latest = state.sales.slice(0, 5);
  els.latestSalesList.innerHTML = latest.length
    ? latest.map(renderSaleRow).join('')
    : `
      <div class="empty-state">
        <strong>Nenhuma venda registrada ainda.</strong>
        <span>Quando uma nova venda for recebida pelo Mercado Pago, ela aparecerá automaticamente aqui.</span>
      </div>
    `;
}

function renderSalesList() {
  const filtered = getFilteredSales();
  els.salesList.innerHTML = filtered.length
    ? filtered.map(renderSaleRow).join('')
    : `
      <div class="empty-state">
        <strong>Nenhuma venda encontrada.</strong>
        <span>Ajuste os filtros ou aguarde uma nova notificação do Mercado Pago.</span>
      </div>
    `;
}

function renderSaleRow(sale) {
  const payment = sale.payment || {};
  const transaction = payment.transaction_id || sale.provider_payment_id || sale.provider_order_id || '-';
  const terminal = payment.provider_terminal_id ? `Terminal ${payment.provider_terminal_id}` : 'Point Smart';
  const installments = payment.installments && Number(payment.installments) > 1 ? ` • ${payment.installments}x` : '';

  return `
    <article class="sale-row">
      <div class="sale-main">
        <span class="sale-number">Venda #${String(sale.id).padStart(4, '0')}</span>
        <strong>${currency.format((sale.total_cents || 0) / 100)}</strong>
      </div>
      <div class="sale-meta">
        <span>${escapeHtml(paymentLabel(sale))}${escapeHtml(installments)}</span>
        <span>${escapeHtml(formatTime(sale.created_at))}</span>
        <span>${escapeHtml(terminal)}</span>
      </div>
      <div class="sale-footer">
        <span class="muted">Transação ${escapeHtml(transaction)}</span>
        <span class="pill ${statusClass(sale.status)}">${escapeHtml(statusLabel(sale.status))}</span>
      </div>
    </article>
  `;
}

function getFilteredSales() {
  const search = normalizeSearch(els.salesSearchInput?.value);
  const status = els.salesStatusFilter?.value || '';
  const payment = els.salesPaymentFilter?.value || '';
  const period = els.salesPeriodFilter?.value || 'today';
  const minAmount = Number.parseFloat(els.salesMinAmountInput?.value || '0') || 0;

  return state.sales.filter((sale) => {
    if (status && sale.status !== status) return false;
    if (payment && sale.payment_method !== payment) return false;
    if (minAmount > 0 && (sale.total_cents || 0) < Math.round(minAmount * 100)) return false;
    if (!matchesPeriod(sale.created_at, period)) return false;
    if (!search) return true;

    const paymentData = sale.payment || {};
    const haystack = normalizeSearch(
      [
        sale.id,
        sale.external_reference,
        sale.provider_order_id,
        sale.provider_payment_id,
        paymentData.transaction_id,
        paymentData.provider_order_id,
        paymentData.provider_terminal_id,
        paymentData.card_brand,
        paymentData.provider_payment_method_id,
      ].join(' '),
    );
    return haystack.includes(search);
  });
}

function renderMercadoPagoStatus() {
  const mp = state.mercadoPago || {};
  const connection = mp.connection || {};
  const connected = Boolean(mp.connected);
  const hasFallbackToken = Boolean(mp.env_access_token_configured);

  els.mercadoPagoStatus.innerHTML = connected
    ? `
      <div class="status-heading">
        <span class="status-dot ok"></span>
        <div>
          <strong>Mercado Pago conectado</strong>
          <span>Conta ${escapeHtml(connection.mercado_pago_user_id || 'vinculada por OAuth')}</span>
        </div>
      </div>
      <dl class="detail-list">
        <div><dt>Escopo</dt><dd>${escapeHtml(connection.scope || 'Não informado')}</dd></div>
        <div><dt>Conectado em</dt><dd>${escapeHtml(formatDateTime(connection.connected_at))}</dd></div>
      </dl>
    `
    : `
      <div class="status-heading">
        <span class="status-dot ${hasFallbackToken ? 'warning' : ''}"></span>
        <div>
          <strong>Mercado Pago não conectado</strong>
          <span>${hasFallbackToken ? 'Há um Access Token configurado no servidor.' : 'Conecte sua conta pelo OAuth oficial.'}</span>
        </div>
      </div>
    `;

  els.connectMercadoPagoButton.hidden = connected;
  els.disconnectMercadoPagoButton.hidden = !connected;
  renderTerminals(mp.terminals || [], mp.active_terminal || null);
}

function renderConnectionSummary() {
  const mp = state.mercadoPago || {};
  const connected = Boolean(mp.connected || mp.env_access_token_configured);
  const active = mp.active_terminal;

  els.dashboardConnectionSummary.innerHTML = `
    <div class="connection-line">
      <span class="status-dot ${connected ? 'ok' : ''}"></span>
      <div>
        <strong>Mercado Pago</strong>
        <span>${connected ? 'Conectado' : 'Não conectado'}</span>
      </div>
    </div>
    <div class="connection-line">
      <span class="status-dot ${active ? 'ok' : 'warning'}"></span>
      <div>
        <strong>Point Smart</strong>
        <span>${active ? escapeHtml(active.nickname || active.mercado_pago_terminal_id) : 'Nenhum terminal ativo'}</span>
      </div>
    </div>
    <div class="connection-note">Webhook: https://big-lanche.onrender.com/api/mercadopago/webhook</div>
  `;
}

function renderTerminals(terminals, activeTerminal) {
  const activeId = activeTerminal?.mercado_pago_terminal_id || null;

  els.currentTerminalCard.innerHTML = activeTerminal
    ? `
      <div class="terminal-title">
        <span class="status-dot ok"></span>
        <div>
          <strong>${escapeHtml(activeTerminal.nickname || 'Point Smart')}</strong>
          <span>${escapeHtml(activeTerminal.mercado_pago_terminal_id)}</span>
        </div>
      </div>
      <dl class="detail-list">
        <div><dt>Modo</dt><dd>${escapeHtml(activeTerminal.operating_mode || 'Não informado')}</dd></div>
        <div><dt>Loja</dt><dd>${escapeHtml(activeTerminal.store_id || '-')}</dd></div>
        <div><dt>Caixa</dt><dd>${escapeHtml(activeTerminal.pos_id || activeTerminal.external_pos_id || '-')}</dd></div>
      </dl>
    `
    : `
      <div class="empty-state left">
        <strong>Nenhuma Point ativa.</strong>
        <span>Sincronize os terminais da conta Mercado Pago e escolha a Point principal.</span>
      </div>
    `;

  els.terminalsList.innerHTML = terminals.length
    ? terminals
        .map((terminal) => {
          const terminalId = terminal.mercado_pago_terminal_id;
          const isActive = activeId && terminalId === activeId;
          return `
            <article class="terminal-row">
              <div>
                <strong>${escapeHtml(terminal.nickname || 'Point Smart')}</strong>
                <span>${escapeHtml(terminalId)}</span>
                <small>Modo: ${escapeHtml(terminal.operating_mode || 'Não informado')}</small>
              </div>
              <button class="${isActive ? 'secondary-button' : 'ghost-button'} small" type="button" data-terminal-id="${escapeHtml(terminalId)}">
                ${isActive ? 'Ativa' : 'Usar'}
              </button>
            </article>
          `;
        })
        .join('')
    : '<div class="empty-state"><strong>Nenhum terminal sincronizado.</strong><span>Clique em sincronizar para consultar a conta Mercado Pago.</span></div>';

  els.terminalsList.querySelectorAll('[data-terminal-id]').forEach((button) => {
    button.addEventListener('click', () => setActiveTerminal(button.dataset.terminalId));
  });
}

function renderCashSummary(summary = {}) {
  const entries = [
    ['Faturamento bruto', summary.gross_revenue_cents || 0],
    ['Cartão', summary.card_cents || 0],
    ['Pix', summary.pix_cents || 0],
    ['Dinheiro', summary.cash_cents || 0],
    ['Total recebido', summary.total_received_cents || 0],
    ['Total cancelado', summary.total_cancelled_cents || 0],
    ['Total estornado', summary.total_refunded_cents || 0],
  ];

  els.cashSummary.innerHTML = entries
    .map(
      ([label, value]) => `
        <div class="cash-box">
          <span>${escapeHtml(label)}</span>
          <strong>${currency.format(value / 100)}</strong>
        </div>
      `,
    )
    .join('');
}

function renderCashMovements(movements) {
  els.cashMovements.innerHTML = movements.length
    ? movements
        .map(
          (movement) => `
            <div class="movement-row">
              <div>
                <strong>${escapeHtml(movement.type || 'Movimento')}</strong>
                <span>${escapeHtml(paymentMethodName(movement.payment_method))} • ${escapeHtml(formatTime(movement.created_at))}</span>
              </div>
              <strong>${currency.format((movement.amount_cents || 0) / 100)}</strong>
            </div>
          `,
        )
        .join('')
    : '<div class="empty-state"><strong>Sem movimentações hoje.</strong><span>O caixa recebe apenas vendas aprovadas.</span></div>';
}

function renderUser() {
  const user = state.user || {};
  const firstName = String(user.name || 'operador').trim().split(/\s+/)[0] || 'operador';
  els.userFirstName.textContent = firstName;
  els.accountName.textContent = user.name || 'Usuário';
  els.accountEmail.textContent = user.email || '';
  els.accountAvatar.textContent = initials(user.name || user.email || 'BL');
  els.accountVerified.textContent = user.email_verified ? 'E-mail verificado' : 'E-mail pendente';
  els.accountVerified.className = `pill ${user.email_verified ? 'ok' : 'warning'}`;
}

function renderPasswordStrength() {
  const password = els.registerPasswordInput?.value || '';
  const rules = {
    length: password.length >= 8,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /\d/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
  };
  const score = Object.values(rules).filter(Boolean).length;
  els.passwordStrengthBar.style.width = `${score * 20}%`;
  els.passwordStrengthBar.dataset.score = String(score);

  Object.entries(rules).forEach(([rule, passed]) => {
    const item = els.passwordRequirements.querySelector(`[data-rule="${rule}"]`);
    if (item) item.classList.toggle('ok', passed);
  });
}

function renderLoadingState() {
  els.metricsGrid.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
  els.latestSalesList.innerHTML = '<div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div>';
  els.salesList.innerHTML = '<div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div>';
  els.cashSummary.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
  els.cashMovements.innerHTML = '<div class="skeleton-line"></div><div class="skeleton-line"></div>';
}

async function syncTerminals() {
  await withButtonLoading(els.syncTerminalsButton, 'Sincronizando...', async () => {
    try {
      const { terminals } = await api('/api/mercadopago/sync-terminals', { method: 'POST' });
      state.mercadoPago = {
        ...(state.mercadoPago || {}),
        terminals,
        active_terminal: terminals.find((terminal) => terminal.active) || null,
      };
      renderMercadoPagoStatus();
      renderConnectionSummary();
      updateSidebarTerminalState();
      showToast('Terminais sincronizados.', 'success');
    } catch (error) {
      showToast(error.message, 'danger');
    }
  });
}

async function setActiveTerminal(terminalId) {
  if (!terminalId) return;

  try {
    const { terminals } = await api('/api/mercadopago/active-terminal', {
      method: 'POST',
      body: { mercado_pago_terminal_id: terminalId },
    });
    state.mercadoPago = {
      ...(state.mercadoPago || {}),
      terminals,
      active_terminal: terminals.find((terminal) => terminal.active) || null,
    };
    renderMercadoPagoStatus();
    renderConnectionSummary();
    updateSidebarTerminalState();
    showToast('Point ativa atualizada.', 'success');
  } catch (error) {
    showToast(error.message, 'danger');
  }
}

async function testMercadoPagoConnection() {
  await withButtonLoading(els.testConnectionButton, 'Testando...', async () => {
    try {
      await loadMercadoPagoStatus();
      if (state.mercadoPago?.connected || state.mercadoPago?.env_access_token_configured) {
        showToast('Conexão Mercado Pago respondendo.', 'success');
        return;
      }
      showToast('Conecte o Mercado Pago para testar a conta.', 'warning');
    } catch (error) {
      showToast(error.message, 'danger');
    }
  });
}

async function disconnectMercadoPago() {
  await withButtonLoading(els.disconnectMercadoPagoButton, 'Desconectando...', async () => {
    try {
      await api('/api/mercadopago/disconnect', { method: 'POST' });
      await loadMercadoPagoStatus();
      showToast('Mercado Pago desconectado.', 'success');
    } catch (error) {
      showToast(error.message, 'danger');
    }
  });
}

async function closeCashRegister() {
  await withButtonLoading(els.closeCashButton, 'Fechando...', async () => {
    try {
      const current = await api('/api/cash-registers/current');
      await api(`/api/cash-registers/${current.cash_register.id}/close`, { method: 'POST' });
      await loadCashSummary();
      showToast('Caixa fechado.', 'success');
    } catch (error) {
      showToast(error.message, 'danger');
    }
  });
}

function showAuthView(view, { push = false } = {}) {
  stopPolling();
  const target = view || 'login';
  els.authShell.classList.remove('hidden');
  els.appShell.classList.add('hidden');
  document.body.classList.add('auth-mode');

  document.querySelectorAll('.auth-view').forEach((section) => {
    section.classList.toggle('active', section.id === `auth-${target}`);
  });

  if (push) history.pushState({}, '', routes[target] || routes.login);
}

function showAppView(view, { push = false } = {}) {
  const target = view || 'dashboard';
  els.authShell.classList.add('hidden');
  els.appShell.classList.remove('hidden');
  document.body.classList.remove('auth-mode');

  document.querySelectorAll('.nav-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === target);
  });
  document.querySelectorAll('.view').forEach((section) => {
    section.classList.toggle('active', section.id === `view-${target}`);
  });

  closeSidebar();
  if (push) history.pushState({}, '', routes[target] || routes.dashboard);

  if (target === 'mercadopago' && state.user) loadMercadoPagoStatus().catch((error) => showToast(error.message, 'danger'));
  if (target === 'reports' && state.user) loadCashSummary().catch((error) => showToast(error.message, 'danger'));
}

function openSidebar() {
  els.sidebar.classList.add('open');
  els.sidebarBackdrop.classList.remove('hidden');
}

function closeSidebar() {
  els.sidebar.classList.remove('open');
  els.sidebarBackdrop.classList.add('hidden');
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    refreshPrivateData().catch((error) => showToast(error.message, 'danger'));
  }, 8000);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function detectNewSales(sales) {
  const nextIds = new Set(sales.map((sale) => String(sale.id)));

  if (state.salesLoaded) {
    const newSale = sales.find((sale) => !state.saleIds.has(String(sale.id)));
    if (newSale) showToast('Nova venda registrada.', 'success');
  }

  state.saleIds = nextIds;
  state.salesLoaded = true;
}

function updateSidebarTerminalState() {
  const mp = state.mercadoPago || {};
  const active = mp.active_terminal;
  const connected = Boolean(mp.connected || mp.env_access_token_configured);
  const dot = els.terminalState.querySelector('.status-dot');
  const label = els.terminalState.querySelector('span:last-child');

  dot.classList.toggle('ok', Boolean(active));
  dot.classList.toggle('warning', connected && !active);
  label.textContent = active
    ? `Point ativa: ${active.nickname || active.mercado_pago_terminal_id}`
    : connected
      ? 'Mercado Pago conectado'
      : 'Mercado Pago não conectado';
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };
  const unsafe = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (unsafe) headers['x-csrf-token'] = state.csrfToken || readCookie('big_lanche_csrf') || '';

  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const data = text ? safeJson(text) : null;

  if (response.status === 401 && !options.ignoreAuthRedirect) {
    showAuthView('login', { push: true });
    throw createClientError(data, 'Sua sessão expirou. Entre novamente.');
  }

  if (!response.ok) throw createClientError(data, 'Falha na comunicação com o servidor.');
  return data || {};
}

function createClientError(data, fallback) {
  const error = new Error(data?.error?.message || data?.message || fallback);
  error.code = data?.error?.code || data?.code || null;
  error.details = data?.error?.details || null;
  return error;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function withButtonLoading(button, label, task) {
  if (!button) return task();
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function togglePassword(button) {
  const input = document.getElementById(button.dataset.togglePassword);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.innerHTML = show ? '&times;' : '&#128065;';
  button.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
}

function resolveAuthViewFromPath() {
  return authViewByPath[window.location.pathname] || 'login';
}

function resolveAppViewFromPath() {
  return appViewByPath[window.location.pathname] || 'dashboard';
}

function paymentLabel(sale) {
  const payment = sale.payment || {};
  const type = String(payment.provider_payment_method_type || payment.card_type || '').toLowerCase();
  const methodId = String(payment.card_brand || payment.provider_payment_method_id || '').toLowerCase();
  const brand = brandName(methodId);

  if (sale.payment_method === 'PIX' || type.includes('pix') || type === 'qr') return 'Pix';
  if (type.includes('debit')) return brand ? `Débito • ${brand}` : 'Débito';
  if (type.includes('credit')) return brand ? `Crédito • ${brand}` : 'Crédito';
  if (sale.payment_method === 'CARD') return brand ? `Cartão • ${brand}` : 'Cartão';
  return sale.payment_method || 'Mercado Pago';
}

function paymentMethodName(value) {
  if (value === 'CARD') return 'Cartão';
  if (value === 'PIX') return 'Pix';
  if (value === 'CASH') return 'Dinheiro';
  return value || '-';
}

function brandName(value) {
  if (!value) return '';
  const clean = String(value).replace(/_/g, ' ').trim();
  const known = {
    amex: 'Amex',
    elo: 'Elo',
    hipercard: 'Hipercard',
    mastercard: 'Mastercard',
    visa: 'Visa',
  };
  return known[clean] || clean.replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusLabel(status) {
  return {
    ACTION_REQUIRED: 'Verificar',
    APPROVED: 'Aprovado',
    CANCELLED: 'Cancelado',
    EXPIRED: 'Expirado',
    PENDING: 'Pendente',
    REFUNDED: 'Estornado',
    REJECTED: 'Falhou',
  }[status] || status || '-';
}

function statusClass(status) {
  return {
    ACTION_REQUIRED: 'warning',
    APPROVED: 'ok',
    CANCELLED: 'danger',
    EXPIRED: 'danger',
    PENDING: 'warning',
    REFUNDED: 'warning',
    REJECTED: 'danger',
  }[status] || '';
}

function matchesPeriod(value, period) {
  if (period === 'all') return true;
  const date = parseDate(value);
  if (!date) return false;

  const now = new Date();
  if (period === 'today') {
    return date.toDateString() === now.toDateString();
  }

  const days = Number.parseInt(period, 10);
  if (!Number.isFinite(days)) return true;
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  return date >= start;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(value) {
  const date = parseDate(value);
  if (!date) return '-';
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(value) {
  const date = parseDate(value);
  if (!date) return '-';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSearch(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function initials(value) {
  const words = String(value || 'BL').trim().split(/\s+/).slice(0, 2);
  return words.map((word) => word[0] || '').join('').toUpperCase() || 'BL';
}

function readCookie(name) {
  const prefix = `${name}=`;
  const cookie = document.cookie.split('; ').find((item) => item.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showToast(message, type = 'success') {
  els.toast.textContent = message;
  els.toast.className = `toast ${type}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.classList.add('hidden');
  }, 4200);
}

function showFatal(message) {
  els.authShell?.classList.remove('hidden');
  els.appShell?.classList.add('hidden');
  showToast(message || 'Não foi possível iniciar o sistema.', 'danger');
}
