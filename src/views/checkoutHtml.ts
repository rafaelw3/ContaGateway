import type { Payment } from '../lib/prisma.js';
import { centsFromStoredAmount } from '../lib/paymentValidation.js';

interface RenderCheckoutOptions {
  payment: Payment;
  qrCodeDataUrl: string;
  baseUrl: string;
}

export function renderCheckoutHtml({ payment, qrCodeDataUrl, baseUrl }: RenderCheckoutOptions): string {
  // Formata a partir dos centavos (unidade canônica) em vez de converter o
  // Decimal do Prisma para float — ver src/lib/paymentValidation.ts.
  const formattedAmount = (centsFromStoredAmount(payment.amount) / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  });

  const expiresAtIso = payment.expiresAt.toISOString();
  const isPaid = payment.status === 'PAID';
  const isExpired = payment.status === 'EXPIRED' || (!isPaid && new Date() > payment.expiresAt);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pagamento Pix - ${formattedAmount} | ContaGateway</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@700;800&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --surface-page: #f8fafc;
      --surface-card: #ffffff;
      --surface-raised: #f1f5f9;
      --border: #e2e8f0;
      --border-strong: #cbd5e1;
      --ink: #0f172a;
      --ink-muted: #64748b;
      --ink-faint: #94a3b8;
      --brand: #132a52;
      --brand-hover: #0b1d3a;
      --on-brand: #ffffff;
      --success: #047857;
      --success-surface: rgba(4, 120, 87, 0.1);
      --success-strong: #047857;
      --warning: #b45309;
      --warning-surface: rgba(180, 83, 9, 0.1);
      --danger: #b91c1c;
      --danger-surface: rgba(185, 28, 28, 0.1);
      --focus-ring: #2563eb;
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 20px;
      --radius-full: 9999px;
      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 24px;
      --space-6: 32px;
      --shadow-card: 0 2px 4px rgba(15, 23, 42, 0.06), 0 20px 40px -14px rgba(15, 23, 42, 0.14);
      --shadow-button: 0 1px 2px rgba(15, 23, 42, 0.06);
      --font-display: 'Outfit', 'Segoe UI', system-ui, sans-serif;
      --font-sans: 'Inter', 'Segoe UI', system-ui, sans-serif;
      --font-mono: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;
    }

    /* Checkout é sempre claro, de propósito — é a identidade pedida
       (Stripe/Nubank-style). Não segue prefers-color-scheme: num teste
       real isso fez o card "sumir" pra quem usa o SO em modo escuro,
       porque ele virava escuro junto com o resto. */

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      -webkit-tap-highlight-color: transparent;
    }

    body {
      font-family: var(--font-sans);
      background-color: var(--surface-page);
      color: var(--ink);
      /* 100vh no mobile recalcula toda vez que a barra de endereço do
         navegador expande/recolhe (o que um toque na tela pode disparar),
         reposicionando o conteúdo centralizado abaixo — daí o "flick" ao
         tocar no botão. 100dvh acompanha a viewport visível de verdade;
         100vh fica só como fallback pra navegador sem suporte a dvh. */
      min-height: 100vh;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: var(--space-6) var(--space-4);
    }

    button:focus-visible {
      outline: 2px solid var(--focus-ring);
      outline-offset: 2px;
    }

    .container {
      width: 100%;
      max-width: 400px;
    }

    .card {
      background: var(--surface-card);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card);
      padding: var(--space-6) var(--space-5);
      text-align: center;
    }

    .amount-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--ink-muted);
      margin-bottom: 4px;
    }

    .amount-value {
      font-family: var(--font-display);
      font-size: 40px;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: var(--ink);
      margin-bottom: var(--space-5);
      font-variant-numeric: tabular-nums;
    }

    /* Badge de status — display:flex (não inline-flex) + width:fit-content +
       margin:0 auto o torna um bloco que se centraliza sozinho, sem depender
       de text-align do pai nem de compartilhar linha com o QR code abaixo.
       Isso evita que uma mudança de texto ("Aguardando Pagamento..." ->
       "Cobrança Expirada") afete a posição de qualquer outro elemento. */
    .status-badge {
      display: flex;
      width: fit-content;
      align-items: center;
      gap: var(--space-2);
      padding: 6px var(--space-3);
      border-radius: var(--radius-full);
      font-size: 13px;
      font-weight: 600;
      margin: 0 auto var(--space-5);
    }

    .status-badge.pending {
      background: var(--warning-surface);
      color: var(--warning);
    }

    .status-badge.paid {
      background: var(--success-surface);
      color: var(--success);
    }

    .status-badge.expired {
      background: var(--danger-surface);
      color: var(--danger);
    }

    .pulse-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background-color: currentColor;
      animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(1.2); }
    }

    /* Container do QR Code — mesmo princípio do .status-badge acima: bloco
       que se autocentraliza via margin:0 auto, nunca compartilha linha com
       nada, nunca desloca por causa de texto de outro elemento mudando. */
    .qrcode-wrapper {
      display: block;
      width: fit-content;
      margin: 0 auto var(--space-5);
      background: var(--surface-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-4);
    }

    .qrcode-image {
      display: block;
      width: 200px;
      height: 200px;
      border-radius: var(--radius-sm);
      image-rendering: pixelated;
    }

    /* Caixa do Copia e Cola */
    .copy-box {
      margin-bottom: var(--space-5);
      text-align: left;
    }

    .copy-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--ink-muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: var(--space-2);
      display: flex;
      justify-content: space-between;
    }

    .payload-input {
      width: 100%;
      background: var(--surface-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: var(--space-3) var(--space-4);
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--ink-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: var(--space-3);
      user-select: all;
    }

    .btn-copy {
      width: 100%;
      background: var(--brand);
      color: var(--on-brand);
      border: none;
      border-radius: var(--radius-md);
      padding: var(--space-4) var(--space-5);
      font-family: var(--font-sans);
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      white-space: nowrap;
      transition: background-color 0.15s ease, transform 0.1s ease;
      box-shadow: var(--shadow-button);
    }

    .btn-copy:hover {
      background: var(--brand-hover);
    }

    .btn-copy:active {
      transform: translateY(1px);
    }

    .btn-copy.copied {
      background: var(--success-strong);
    }

    /* Instruções */
    .instructions {
      border-top: 1px solid var(--border);
      padding-top: var(--space-5);
      margin-top: var(--space-5);
      text-align: left;
    }

    .instructions-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--ink);
      margin-bottom: var(--space-3);
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    .instructions-title svg {
      color: var(--ink-muted);
    }

    .steps-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }

    .steps-list li {
      font-size: 13px;
      color: var(--ink-muted);
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
      line-height: 1.4;
    }

    .step-number {
      background: var(--surface-raised);
      border: 1px solid var(--border);
      color: var(--ink-muted);
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: bold;
      flex-shrink: 0;
      margin-top: 1px;
    }

    /* Tela de Sucesso */
    .success-view {
      display: none;
      padding: var(--space-4) 0;
    }

    .success-icon-wrapper {
      width: 72px;
      height: 72px;
      background: var(--success-surface);
      border: 2px solid var(--success);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto var(--space-5);
      animation: scaleIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }

    .success-icon-wrapper svg {
      width: 36px;
      height: 36px;
      color: var(--success);
    }

    @keyframes scaleIn {
      from { transform: scale(0); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }

    .success-title {
      font-family: var(--font-display);
      font-size: 28px;
      font-weight: 700;
      color: var(--ink);
      margin-bottom: var(--space-2);
    }

    .success-subtitle {
      font-size: 14px;
      color: var(--ink-muted);
      margin-bottom: var(--space-5);
    }

    .receipt-box {
      background: var(--surface-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: var(--space-3) var(--space-4);
      text-align: left;
      margin-bottom: var(--space-5);
    }

    .receipt-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--ink-faint);
      margin-bottom: 4px;
    }

    .receipt-code {
      font-family: var(--font-mono);
      font-size: 16px;
      font-weight: 600;
      letter-spacing: 0.5px;
      color: var(--brand);
    }

    .footer {
      margin-top: var(--space-6);
      font-size: 12px;
      color: var(--ink-faint);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-1);
    }
  </style>
</head>
<body>
  <main class="container">
    <div class="card" id="payment-card">
      <!-- VISÃO: PAGAMENTO PENDENTE -->
      <div id="pending-section" style="${isPaid ? 'display: none;' : 'display: block;'}">
        <p class="amount-label">Valor total a pagar</p>
        <h1 class="amount-value">${formattedAmount}</h1>

        <div class="status-badge ${isExpired ? 'expired' : 'pending'}" id="status-badge">
          <div class="pulse-dot"></div>
          <span id="status-text">${isExpired ? 'Cobrança Expirada' : 'Aguardando Pagamento...'}</span>
        </div>

        <div class="qrcode-wrapper">
          <img src="${qrCodeDataUrl}" alt="QR Code Pix" class="qrcode-image" id="qrcode-img" />
        </div>

        <div class="copy-box">
          <div class="copy-label">
            <span>Pix Copia e Cola</span>
            <span id="timer-text" style="color: var(--ink-muted); font-weight: normal; text-transform: none; letter-spacing: normal; font-variant-numeric: tabular-nums;">Calculando tempo...</span>
          </div>
          <div class="payload-input" id="payload-text">${payment.pixPayload}</div>
          <button class="btn-copy" id="btn-copy" onclick="copyPixCode()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
            </svg>
            <span id="btn-copy-text">Copiar Código Pix</span>
          </button>
        </div>

        <div class="instructions">
          <p class="instructions-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" x2="12" y1="8" y2="12"/>
              <line x1="12" x2="12.01" y1="16" y2="16"/>
            </svg>
            Como pagar com Pix:
          </p>
          <ul class="steps-list">
            <li>
              <span class="step-number">1</span>
              <span>Abra o app do seu banco ou carteira digital de preferência.</span>
            </li>
            <li>
              <span class="step-number">2</span>
              <span>Escolha pagar via <strong>Pix</strong> e escaneie o QR Code ou cole o código acima.</span>
            </li>
            <li>
              <span class="step-number">3</span>
              <span>Confirme os dados e conclua o pagamento. A tela atualizará instantaneamente.</span>
            </li>
          </ul>
        </div>
      </div>

      <!-- VISÃO: PAGAMENTO APROVADO -->
      <div id="success-section" class="success-view" style="${isPaid ? 'display: block;' : 'display: none;'}">
        <div class="success-icon-wrapper">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <h2 class="success-title">Pagamento Confirmado!</h2>
        <p class="success-subtitle">O seu pagamento de <strong style="color: var(--success);">${formattedAmount}</strong> foi confirmado com sucesso.</p>

        <div class="receipt-box" id="receipt-box-container" style="${payment.receiptCode ? '' : 'display: none;'}">
          <p class="receipt-label">Código de Confirmação</p>
          <span class="receipt-code" id="receipt-code-value">${payment.receiptCode || ''}</span>
        </div>

        <div class="status-badge paid">
          <span>Status: Concluído</span>
        </div>
      </div>
    </div>

    <footer class="footer">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
      <span>Pagamento processado com segurança por ContaGateway</span>
    </footer>
  </main>

  <script>
    const paymentId = "${payment.id}";
    const pixPayload = ${JSON.stringify(payment.pixPayload)};
    const expiresAt = new Date("${expiresAtIso}").getTime();
    let isSettled = ${isPaid};

    // 1. Função de Cópia em 1 Clique — usa a constante pixPayload (já
    // conhecida no load da página) em vez de ler o texto renderizado do
    // DOM: ler innerText força um reflow síncrono, que se coincidir com
    // a troca de fonte (Google Fonts ainda carregando) causa um salto
    // visível no texto abaixo do botão bem na hora do clique.
    function copyPixCode() {
      navigator.clipboard.writeText(pixPayload).then(() => {
        const btn = document.getElementById('btn-copy');
        const btnText = document.getElementById('btn-copy-text');
        btn.classList.add('copied');
        btnText.innerText = 'Copiado! ✓';
        setTimeout(() => {
          btn.classList.remove('copied');
          btnText.innerText = 'Copiar Código Pix';
        }, 3000);
      }).catch(err => {
        console.error('Falha ao copiar:', err);
      });
    }

    // 2. Contador Regressivo de Expiração
    function updateCountdown() {
      if (isSettled) return;
      const now = Date.now();
      const diff = expiresAt - now;

      const timerEl = document.getElementById('timer-text');
      if (!timerEl) return;

      if (diff <= 0) {
        timerEl.innerText = 'Expirado';
        timerEl.style.color = 'var(--danger)';
        const badge = document.getElementById('status-badge');
        const badgeText = document.getElementById('status-text');
        if (badge) {
          badge.className = 'status-badge expired';
          badgeText.innerText = 'Cobrança Expirada';
        }
        return;
      }

      const minutes = Math.floor(diff / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      timerEl.innerText = 'Expira em ' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }

    setInterval(updateCountdown, 1000);
    updateCountdown();

    // 3. Polling em Tempo Real da Liquidação
    async function checkPaymentStatus() {
      if (isSettled) return;

      try {
        const response = await fetch('/v1/payments/' + paymentId + '/status');
        if (!response.ok) return;

        const data = await response.json();
        if (data && data.status === 'PAID') {
          isSettled = true;
          showSuccessScreen(data.receiptCode);
        }
      } catch (err) {
        // Silêncio em oscilações momentâneas de rede
      }
    }

    function showSuccessScreen(receiptCode) {
      document.getElementById('pending-section').style.display = 'none';
      const successSection = document.getElementById('success-section');
      successSection.style.display = 'block';

      if (receiptCode) {
        document.getElementById('receipt-box-container').style.display = 'block';
        document.getElementById('receipt-code-value').innerText = receiptCode;
      }
    }

    // Polling a cada 1 segundo — resposta mais rápida na tela pro pagador
    // (o "/status" é uma rota pública e barata, sem custo de gerar QR Code).
    const pollInterval = setInterval(() => {
      if (isSettled) {
        clearInterval(pollInterval);
      } else {
        checkPaymentStatus();
      }
    }, 1000);
  </script>
</body>
</html>`;
}
