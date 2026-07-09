// Shared Microsoft sign-in for the Tribute Operating System dashboards.
// Same MSAL pattern as TributeKSFs/tribute-afterhours: cacheLocation
// localStorage means a login on one dashboard silently carries over to
// every other page that uses this script, no repeated prompts. Fully
// self-contained (injects its own styles under unique names) since these
// pages have no shared stylesheet and no existing gate mechanism to hook
// into — avoids the class-name collision that broke this on TributeKSFs.
(() => {
  const CFG = {
    clientId: '1df79777-9577-494b-b4f0-3dc7621a3e76',
    tenantId: '3277c56b-67a5-4dbc-9f82-474b19e15eb3',
    get apiScope() { return 'api://' + this.clientId + '/Dashboards.Read'; },
  };

  const LOCK_CLASS = 'entra-signin-locked';
  const OVERLAY_ID = 'entraSignInOverlay';
  // MSAL flatly refuses redirect-based login/token-acquisition inside an
  // iframe (index_live.html's embedded panels, retention_tracker.html
  // embedded in the rise-dashboard suite, etc.) — has to use the popup
  // APIs there instead. Top-level pages keep using redirect, which is the
  // less disruptive of the two (no popup-blocker risk).
  const IS_IFRAME = window.self !== window.top;
  const state = { msal: null, account: null };

  // 2026-07-09: getToken() used to check state.account immediately with no
  // wait — but a page's own inline <script> (its data-fetch IIFE) runs
  // synchronously as the parser reaches it, which is often BEFORE
  // DOMContentLoaded even fires, let alone before init() (triggered by that
  // same event) finishes its awaits. getToken() was returning null on that
  // first call every time, not because sign-in failed but because it never
  // waited for init() to run at all. Harmless while every backend endpoint
  // was ungated; surfaced as real 401s the moment they started requiring
  // this token. resolveReady() fires once init() completes either way, so
  // getToken() called at any point — even before init() has started —
  // correctly waits instead of racing it.
  let resolveReady;
  const readyPromise = new Promise((resolve) => { resolveReady = resolve; });

  const injectStyles = () => {
    if (document.getElementById('entra-signin-styles')) return;
    const s = document.createElement('style');
    s.id = 'entra-signin-styles';
    s.textContent = `
      html.${LOCK_CLASS} body > *:not(#${OVERLAY_ID}) { display: none !important; }
      #${OVERLAY_ID} { position: fixed; inset: 0; z-index: 999999; background: #f7f5f2;
        display: flex; align-items: center; justify-content: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; }
      #${OVERLAY_ID} .entra-card { width: 340px; max-width: 90vw; text-align: center; background: #fff;
        border: 1px solid #e5e1da; border-radius: 14px; padding: 32px 28px; box-shadow: 0 10px 28px -8px rgba(28,26,23,.12); }
      #${OVERLAY_ID} .entra-brand { font-size: 11px; font-weight: 700; letter-spacing: .1em; color: #b7b0a6; margin-bottom: 6px; }
      #${OVERLAY_ID} h1 { font-size: 19px; font-weight: 700; color: #1c1a17; margin: 0 0 8px; }
      #${OVERLAY_ID} p { font-size: 13px; color: #6b6b6b; margin: 0 0 22px; }
      #${OVERLAY_ID} button { width: 100%; padding: 11px 14px; font-size: 14px; font-weight: 600; color: #fff;
        background: #ff5a1f; border: none; border-radius: 10px; cursor: pointer; }
      #${OVERLAY_ID} button:hover { background: #e04a15; }
      #${OVERLAY_ID} .entra-error { font-size: 12px; color: #c0392b; margin-top: 14px; min-height: 14px; }
      #entraAuthBadge { position: fixed; bottom: 10px; right: 10px; z-index: 999998; display: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; font-size: 10px;
        opacity: .55; transition: opacity .15s; }
      #entraAuthBadge:hover { opacity: 1; }
      #entraAuthBadge span { background: #e9f5db; color: #2f6f12; padding: 3px 9px; border-radius: 999px; font-weight: 600; margin-right: 4px; }
      #entraAuthBadge button { background: #eee; color: #333; border: none; padding: 3px 9px; border-radius: 999px; font-weight: 600; cursor: pointer; font-size: 10px; }
    `;
    document.head.appendChild(s);
  };

  const showBadge = () => {
    if (!state.account) return;
    // Pages like index_live.html embed several dashboards at once as iframes;
    // each one running this script would otherwise stack a badge on top of
    // the other. Only the top-level page shows one.
    if (window.self !== window.top) return;
    let badge = document.getElementById('entraAuthBadge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'entraAuthBadge';
      badge.innerHTML = `<span id="entraAuthName"></span><button id="entraAuthSignOut" type="button">Sign out</button>`;
      document.body.appendChild(badge);
      badge.querySelector('#entraAuthSignOut').addEventListener('click', () => window.tributeKsfGate.signOut());
    }
    badge.querySelector('#entraAuthName').textContent = state.account.name || state.account.username || '';
    badge.style.display = 'block';
  };

  const reveal = () => {
    document.documentElement.classList.remove(LOCK_CLASS);
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.remove();
    showBadge();
    document.dispatchEvent(new CustomEvent('tribute-gate-unlocked'));
  };

  const buildOverlay = () => {
    injectStyles();
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
      <div class="entra-card">
        <div class="entra-brand">TRIBUTE HOME CARE</div>
        <h1>Sign in required</h1>
        <p>Sign in with your Tribute Microsoft account to continue.</p>
        <button id="entraSignInBtn" type="button">Sign in with Microsoft</button>
        <div class="entra-error" id="entraSignInError"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#entraSignInBtn').addEventListener('click', () => {
      if (IS_IFRAME) {
        state.msal.loginPopup({ scopes: [CFG.apiScope] })
          .then((r) => { state.account = r.account; reveal(); })
          .catch(showError);
      } else {
        state.msal.loginRedirect({ scopes: [CFG.apiScope] }).catch(showError);
      }
    });
  };

  function showError(e) {
    injectStyles();
    const el = document.getElementById('entraSignInError');
    if (el) el.textContent = 'Sign-in failed: ' + ((e && (e.errorMessage || e.message)) || 'unknown error');
  }

  async function init() {
    try {
      state.msal = new msal.PublicClientApplication({
        auth: {
          clientId: CFG.clientId,
          authority: `https://login.microsoftonline.com/${CFG.tenantId}`,
          redirectUri: location.origin + location.pathname,
        },
        cache: { cacheLocation: 'localStorage' },
      });
      await state.msal.initialize();
      // handleRedirectPromise() is only relevant to the redirect flow, which
      // iframed pages never use (and calling it can itself throw the same
      // "not supported in an iframe" error there) — skip it in that case.
      const resp = IS_IFRAME ? null : await state.msal.handleRedirectPromise().catch((e) => { showError(e); return null; });
      const accts = state.msal.getAllAccounts();
      state.account = (resp && resp.account) || accts[0] || null;
      if (state.account) reveal();
      else buildOverlay();
    } catch (e) {
      console.error('Sign-in initialization failed, clearing local session and showing the sign-in prompt', e);
      try { localStorage.clear(); } catch {}
      buildOverlay();
      showError(e);
    } finally {
      resolveReady();
    }
  }

  async function getToken() {
    await readyPromise;
    if (!state.account) return null;
    try {
      const r = await state.msal.acquireTokenSilent({ scopes: [CFG.apiScope], account: state.account });
      return r.accessToken;
    } catch (e) {
      if (IS_IFRAME) {
        try {
          const r = await state.msal.acquireTokenPopup({ scopes: [CFG.apiScope] });
          return r.accessToken;
        } catch (e2) {
          return null;
        }
      }
      await state.msal.acquireTokenRedirect({ scopes: [CFG.apiScope] });
      return null;
    }
  }

  window.tributeKsfGate = {
    getToken,
    isSignedIn() { return !!state.account; },
    signOut() {
      if (!state.msal) return;
      if (IS_IFRAME) state.msal.logoutPopup({ account: state.account }).catch(() => {});
      else state.msal.logoutRedirect({ account: state.account });
    },
  };

  injectStyles();
  document.documentElement.classList.add(LOCK_CLASS);
  document.addEventListener('DOMContentLoaded', init);
})();
