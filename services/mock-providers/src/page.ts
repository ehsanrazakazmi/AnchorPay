// The mock card form: a plain, accessible HTML page (no scripts) that looks like a hosted payment page.
import type { MockPayment } from './store.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (m: { amountMinor: number; currency: string }) => `${m.currency} ${(m.amountMinor / 100).toFixed(2)}`;

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Mock card processor</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f5f7; --card: #fff; --text: #1d2330; --muted: #5d6677; --accent: #1f6feb; --error: #c62828; }
  @media (prefers-color-scheme: dark) { :root { --bg: #11151c; --card: #1b212b; --text: #e6e9ef; --muted: #9aa4b5; --accent: #4c8dff; --error: #ff6b6b; } }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--text); }
  main { max-width: 420px; margin: 40px auto; padding: 0 16px; }
  .card { background: var(--card); border-radius: 12px; padding: 24px; box-shadow: 0 2px 12px rgb(0 0 0 / 0.08); }
  .badge { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 99px; background: #ffb70033; color: var(--text); }
  label { display: block; margin-top: 14px; font-weight: 600; font-size: 14px; }
  input { width: 100%; box-sizing: border-box; margin-top: 4px; padding: 10px 12px; font-size: 16px; border: 1px solid var(--muted); border-radius: 8px; background: transparent; color: var(--text); }
  .row { display: flex; gap: 12px; } .row > div { flex: 1; }
  .error { color: var(--error); font-size: 14px; margin: 4px 0 0; }
  button { margin-top: 20px; width: 100%; padding: 12px; font-size: 16px; font-weight: 600; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer; }
  .hint { color: var(--muted); font-size: 13px; } code { font-size: 13px; }
</style></head><body><main><div class="card">${body}</div></main></body></html>`;

export function authorizePage(p: MockPayment, errors: Record<string, string>): string {
  const err = (field: string) => (errors[field] ? `<p class="error" id="${field}-error">${esc(errors[field])}</p>` : '');
  const aria = (field: string) => (errors[field] ? ` aria-invalid="true" aria-describedby="${field}-error"` : '');
  return layout('Authorise payment', `
  <span class="badge">TEST MODE · no real money</span>
  <h1 style="font-size:22px;margin:12px 0 4px">Pay AnchorPay</h1>
  <p style="margin:0 0 8px;font-size:28px;font-weight:700">${esc(money(p.amount))}</p>
  <p class="hint">The amount is only held now. It is charged after your transfer passes its checks.</p>
  <form method="post" action="/card/authorize/${esc(p.id)}" novalidate>
    <label for="cardNumber">Card number</label>
    <input id="cardNumber" name="cardNumber" inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242"${aria('cardNumber')}>
    ${err('cardNumber')}
    <div class="row">
      <div><label for="expiry">Expiry</label><input id="expiry" name="expiry" autocomplete="cc-exp" placeholder="MM/YY"${aria('expiry')}>${err('expiry')}</div>
      <div><label for="cvc">CVC</label><input id="cvc" name="cvc" inputmode="numeric" autocomplete="cc-csc" placeholder="123"${aria('cvc')}>${err('cvc')}</div>
    </div>
    <button type="submit">Authorise ${esc(money(p.amount))}</button>
  </form>
  <p class="hint">Test cards: <code>4242 4242 4242 4242</code> approved · <code>4000 0000 0000 0002</code> declined ·
  <code>4000 0000 0000 9995</code> insufficient funds. Any future expiry and any 3-digit CVC.</p>`);
}

export function resultPage(title: string, message: string, returnUrl?: string): string {
  return layout(title, `<h1 style="font-size:22px;margin:0 0 8px">${esc(title)}</h1><p>${esc(message)}</p>${
    returnUrl ? `<p><a href="${esc(returnUrl)}">Back to AnchorPay</a></p>` : ''}`);
}
