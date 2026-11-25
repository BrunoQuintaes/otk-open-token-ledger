/**
 * P2.2 — Dashboard Login Page
 *
 * Self-contained login page for the dashboard. Bearer token-based
 * authentication using localStorage for session persistence.
 *
 * Routes (wired into handleRequest in routes.ts):
 *   GET /app/login   — Login page HTML
 *   GET /app/logout  — Clear session, redirect to login
 *
 * `handleLoginRequest` is called by the request dispatcher in `src/api/routes.ts`. The page's own script talks to
 * the API from the browser and keeps the session token in `localStorage`; this module only serves HTML and the
 * logout redirect. It does NOT check credentials and does NOT clear anything on the server at logout.
 *
 * @module src/dashboard/login
 * @since Wave 2 Pack 20 (P2.2)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Login Page HTML ─────────────────────────────────────────────────

/**
 * Returns the self-contained login and sign-up page.
 *
 * @returns A complete HTML document with inline style and script.
 */
export function getLoginHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>OTK zk-Metering - Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0f14;color:#e8eef6;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .login-container{background:#111826;border:1px solid #1c2430;border-radius:16px;padding:40px;width:100%;max-width:400px;margin:20px}
  .login-title{font-size:1.3rem;font-weight:700;margin-bottom:8px;text-align:center}
  .login-subtitle{font-size:0.85rem;color:#7b8fa8;text-align:center;margin-bottom:28px}
  .form-group{margin-bottom:20px}
  .form-group label{display:block;font-size:0.82rem;color:#7b8fa8;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em}
  .form-group input{width:100%;padding:10px 14px;background:#0b0f14;border:1px solid #1c2430;border-radius:8px;color:#e8eef6;font-size:0.95rem;outline:none;transition:border-color 0.2s}
  .form-group input:focus{border-color:#7db7ff}
  .form-group input::placeholder{color:#4a5568}
  .login-btn{width:100%;padding:12px;background:#1a2540;border:1px solid #7db7ff;border-radius:8px;color:#7db7ff;font-size:0.95rem;font-weight:600;cursor:pointer;transition:all 0.2s}
  .login-btn:hover{background:#7db7ff;color:#0b0f14}
  .login-btn:disabled{opacity:0.5;cursor:not-allowed}
  .error-msg{display:none;background:#7f1d1d;color:#fca5a5;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:0.85rem;text-align:center}
  .error-msg.visible{display:block}
  .info-text{font-size:0.78rem;color:#7b8fa8;text-align:center;margin-top:20px;line-height:1.5}
  .info-text a{color:#7db7ff;text-decoration:none}
  .info-text a:hover{text-decoration:underline}
  .logo-area{text-align:center;margin-bottom:24px}
  .logo-area .icon{font-size:2rem;opacity:0.7}
</style>
</head>
<body>

<div class="login-container">
  <div class="logo-area">
    <div class="icon">&#128274;</div>
  </div>
  <div class="login-title">OTK zk-Metering</div>
  <div class="login-subtitle" id="form-subtitle">Sign in with your credentials</div>

  <div class="error-msg" id="error-msg"></div>

  <div id="login-panel">
    <form id="email-login-form" onsubmit="return handleEmailLogin(event)">
      <div class="form-group">
        <label for="email-input">Email</label>
        <input type="email" id="email-input" name="email" placeholder="you@company.com" autocomplete="email" required/>
      </div>
      <div class="form-group">
        <label for="password-input">Password</label>
        <input type="password" id="password-input" name="password" placeholder="Min. 8 characters" autocomplete="current-password" required/>
      </div>
      <button type="submit" class="login-btn" id="email-login-btn">Sign In</button>
    </form>

    <div class="info-text" style="margin:16px 0 8px">
      <a href="#" onclick="showSignup();return false;">Create an account</a> &middot;
      <a href="#" onclick="showTokenLogin();return false;">Use API token instead</a>
    </div>
  </div>

  <div id="signup-panel" style="display:none">
    <form id="signup-form" onsubmit="return handleSignup(event)">
      <div class="form-group">
        <label for="signup-name">Name</label>
        <input type="text" id="signup-name" placeholder="Your name" required/>
      </div>
      <div class="form-group">
        <label for="signup-org">Organization</label>
        <input type="text" id="signup-org" placeholder="Your company" required/>
      </div>
      <div class="form-group">
        <label for="signup-email">Email</label>
        <input type="email" id="signup-email" placeholder="you@company.com" required/>
      </div>
      <div class="form-group">
        <label for="signup-password">Password</label>
        <input type="password" id="signup-password" placeholder="Min. 8 characters" minlength="8" required/>
      </div>
      <button type="submit" class="login-btn" id="signup-btn">Create Account</button>
    </form>
    <div class="info-text" style="margin:16px 0 8px">
      <a href="#" onclick="showLogin();return false;">Already have an account? Sign in</a>
    </div>
  </div>

  <div id="token-panel" style="display:none">
    <form id="login-form" onsubmit="return handleLogin(event)">
      <div class="form-group">
        <label for="token-input">API Token</label>
        <input type="password" id="token-input" name="token" placeholder="Bearer token..." autocomplete="off" required/>
      </div>
      <button type="submit" class="login-btn" id="login-btn">Sign In with Token</button>
    </form>
    <div class="info-text" style="margin:16px 0 8px">
      <a href="#" onclick="showLogin();return false;">Back to email login</a>
    </div>
  </div>

  <div class="info-text">
    <a href="/health">Health Check</a> &middot; <a href="/api-docs">API Docs</a>
  </div>
</div>

<script>
function showSignup() {
  document.getElementById('login-panel').style.display = 'none';
  document.getElementById('token-panel').style.display = 'none';
  document.getElementById('signup-panel').style.display = 'block';
  document.getElementById('form-subtitle').textContent = 'Create your account';
  document.getElementById('error-msg').classList.remove('visible');
}
function showLogin() {
  document.getElementById('signup-panel').style.display = 'none';
  document.getElementById('token-panel').style.display = 'none';
  document.getElementById('login-panel').style.display = 'block';
  document.getElementById('form-subtitle').textContent = 'Sign in with your credentials';
  document.getElementById('error-msg').classList.remove('visible');
}
function showTokenLogin() {
  document.getElementById('login-panel').style.display = 'none';
  document.getElementById('signup-panel').style.display = 'none';
  document.getElementById('token-panel').style.display = 'block';
  document.getElementById('form-subtitle').textContent = 'Sign in with API token';
  document.getElementById('error-msg').classList.remove('visible');
}

function handleEmailLogin(e) {
  e.preventDefault();
  var email = document.getElementById('email-input').value.trim();
  var password = document.getElementById('password-input').value;
  var errorMsg = document.getElementById('error-msg');
  var btn = document.getElementById('email-login-btn');
  btn.disabled = true; btn.textContent = 'Signing in...';
  errorMsg.classList.remove('visible');

  fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: password })
  })
  .then(function(r) { return r.json().then(function(d) { return { status: r.status, data: d }; }); })
  .then(function(res) {
    if (res.status === 200 && res.data.token) {
      localStorage.setItem('otk_token', res.data.token);
      window.location.href = '/app';
    } else {
      errorMsg.textContent = res.data.error?.message || 'Invalid credentials.';
      errorMsg.classList.add('visible');
    }
  })
  .catch(function(err) { errorMsg.textContent = 'Connection failed: ' + err.message; errorMsg.classList.add('visible'); })
  .finally(function() { btn.disabled = false; btn.textContent = 'Sign In'; });
  return false;
}

function handleSignup(e) {
  e.preventDefault();
  var name = document.getElementById('signup-name').value.trim();
  var orgName = document.getElementById('signup-org').value.trim();
  var email = document.getElementById('signup-email').value.trim();
  var password = document.getElementById('signup-password').value;
  var errorMsg = document.getElementById('error-msg');
  var btn = document.getElementById('signup-btn');
  btn.disabled = true; btn.textContent = 'Creating...';
  errorMsg.classList.remove('visible');

  fetch('/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, orgName: orgName, email: email, password: password })
  })
  .then(function(r) { return r.json().then(function(d) { return { status: r.status, data: d }; }); })
  .then(function(res) {
    if (res.status === 201 && res.data.token) {
      localStorage.setItem('otk_token', res.data.token);
      window.location.href = '/app';
    } else {
      errorMsg.textContent = res.data.error?.message || res.data.error?.legacyError || 'Signup failed.';
      errorMsg.classList.add('visible');
    }
  })
  .catch(function(err) { errorMsg.textContent = 'Connection failed: ' + err.message; errorMsg.classList.add('visible'); })
  .finally(function() { btn.disabled = false; btn.textContent = 'Create Account'; });
  return false;
}

function handleLogin(e) {
  e.preventDefault();
  var tokenInput = document.getElementById('token-input');
  var errorMsg = document.getElementById('error-msg');
  var loginBtn = document.getElementById('login-btn');
  var token = tokenInput.value.trim();

  if (!token) {
    errorMsg.textContent = 'Please enter a token.';
    errorMsg.classList.add('visible');
    return false;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = 'Validating...';
  errorMsg.classList.remove('visible');

  fetch('/health', {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
  })
  .then(function(r) {
    if (r.ok) {
      localStorage.setItem('otk_token', token);
      window.location.href = '/app';
    } else if (r.status === 401) {
      errorMsg.textContent = 'Invalid token. Please check your credentials.';
      errorMsg.classList.add('visible');
    } else {
      errorMsg.textContent = 'Server error (' + r.status + '). Try again.';
      errorMsg.classList.add('visible');
    }
  })
  .catch(function(err) {
    errorMsg.textContent = 'Connection failed: ' + err.message;
    errorMsg.classList.add('visible');
  })
  .finally(function() {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
  });

  return false;
}

// Auto-redirect if already authenticated
(function() {
  var token = localStorage.getItem('otk_token');
  if (token) {
    fetch('/health', {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
    })
    .then(function(r) {
      if (r.ok) window.location.href = '/app';
    })
    .catch(function() {});
  }
})();
</script>

</body>
</html>`;
}

// ── Route handler ───────────────────────────────────────────────────

/**
 * Handle login/logout-related requests.
 * Returns true if the request was handled, false otherwise.
 *
 * @param req - Incoming request; only the method is read.
 * @param res - Response, written only when the request is handled.
 * @param pathname - Request path without the query string.
 * @returns True after answering the login page (200) or the logout redirect (302 to the login page).
 */
export function handleLoginRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/app/login') {
    const html = getLoginHtml();
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-length', Buffer.byteLength(html));
    res.end(html);
    return true;
  }

  if (method === 'GET' && pathname === '/app/logout') {
    // Server-side logout: redirect to login page.
    // Client-side: the login page JS checks localStorage on load.
    res.statusCode = 302;
    res.setHeader('location', '/app/login');
    res.end();
    return true;
  }

  return false;
}
